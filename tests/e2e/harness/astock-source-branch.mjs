// A股回归的「源无关」判定层：纯函数，不联网、不碰 DOM、不碰 ctx。
//
// 背景（2026-10-12）：本机对东财 push2* 的通路时通时断，套件里一批「数据必须来自腾讯」的断言
// 因此把「这台机器此刻的网络状态」当成了代码属性 —— 通路恢复那天 10 条集体变红，且红得没有信息量。
// 这个模块把判定拆成两路输入：
//   preferred / observed / hadFailure —— 记忆里的源（把上一次成功的源试在最前，AGENTS.md 的 A股多源约定）、
//                                        本轮插件实际回显的源、以及该段的失败明细（换源解释）
//   reachable —— preflight 结果。**它不当"首选该是谁"的真值**（根路径通 ≠ API 通，实测二者会背离），
//                只在「这段没数据」时判定"是不是所有源都够不着"这一件事
// 输出每条断言的分支结论与一句理由。离线单测（unit-aux 的 sourceBranch 组）把各种形态都钉住。
//
// 判定不变量（2026-10-12 §10 修订后的口径）：
//   1) 回显的源必须是已知源之一；
//   2) 预期源 = 记忆（有记忆时）；没有记忆才用注册表首位。**不看 preflight**；
//   3) observed ≠ 预期源时，必须有失败切换的运行时证据，否则判红（「可用却换源」）；
//   4) 没有数据时：有失败明细或全不可达 → 正确降级；否则判红；
//   5) 出网预算按「observed 是否等于预期源」选档：一致时每链 ≤ 1+retrySlack（撞多家判红），
//      不一致（真换过源）才放宽 —— 不许把上限简单调大来凑绿。

import { MARKET_SOURCES, SOURCE_IDS, sourceLabelOf } from "../plugins/com.pet.astock/market.js";

export { SOURCE_IDS, sourceLabelOf };

/** 注册表里某个 kind 的源清单（按注册表顺序 = 链的实际尝试顺序），带每源的入口 host */
export function registryView(kind, registry = MARKET_SOURCES) {
  const out = [];
  for (const s of registry) {
    const spec = s[kind];
    if (!spec || !Array.isArray(spec.hosts)) continue;
    out.push({ id: s.id, hosts: [...spec.hosts] });
  }
  return out;
}

/** 注册表里出现过的全部 host（preflight 用它决定要探哪些） */
export function allHosts(registry = MARKET_SOURCES) {
  const set = new Set();
  for (const s of registry) {
    for (const kind of ["quote", "depth", "kline", "trend"]) {
      for (const h of s[kind]?.hosts ?? []) set.add(h);
    }
  }
  return [...set];
}

/** 本轮可达的 host → 某 kind 的可用源（至少一个入口可达就算可用）。只服务「全不可达」这一档判定 */
export function availableFor(kind, reachable, registry = MARKET_SOURCES) {
  return registryView(kind, registry)
    .filter((s) => s.hosts.some((h) => reachable?.[h] === true))
    .map((s) => s.id);
}

/**
 * 链的预期源：**有记忆就用记忆**（插件会把上一次成功的源试在最前，AGENTS.md 的 A股多源约定）；
 * 没有记忆才是注册表首位。**不看 preflight** —— 根路径可达 ≠ 接口可用，实测二者会背离（2026-10-12）。
 */
export function firstExpected(kind, preferred = "", registry = MARKET_SOURCES) {
  if (preferred) return preferred;
  return registryView(kind, registry)[0]?.id ?? null;
}

/**
 * 判一条「数据源」断言。
 * observed=null/"" 表示这一段没有数据；换源的运行时证据有两条（任一即可）：
 *   hadFailure —— 整条链全失败的明细（pnl.failed）；
 *   attemptedFailures —— 本轮「实际尝试过的源」记录里的失败次数（pnl.attempted；由插件只增不改地回显）。
 */
export function judgeKindSource({ kind, observed, preferred = "", hadFailure = false, attemptedFailures = 0, reachable, registry = MARKET_SOURCES }) {
  const label = (id) => sourceLabelOf(id) || id || "(空)";
  const expected = firstExpected(kind, preferred, registry);
  if (observed === null || observed === undefined || observed === "") {
    // 没有数据：有失败明细 → 正确降级；否则只有「所有源都够不着」才认，其余判红
    if (hadFailure) return { ok: true, reason: `${kind}: 该段失败且有失败明细，正确降级（无数据）` };
    const avail = availableFor(kind, reachable, registry);
    if (avail.length === 0) return { ok: true, reason: `${kind}: 本轮所有源都不可达，正确降级为失败` };
    return { ok: false, reason: `${kind}: 没有数据、也没有失败明细（preflight 还见到可达入口）` };
  }
  if (!SOURCE_IDS.includes(observed)) {
    return { ok: false, reason: `${kind}: 回显的源 "${observed}" 不在已知源表 ${SOURCE_IDS.join("/")} 内` };
  }
  if (observed === expected) {
    return { ok: true, reason: `${kind}: 与预期源 ${label(expected)} 一致（${preferred ? "先试上次成功的源" : "无记忆时取注册表首位"}）` };
  }
  if (hadFailure || attemptedFailures > 0) {
    const how = hadFailure ? "整段失败明细" : `尝试记录里 ${attemptedFailures} 次失败`;
    return { ok: true, reason: `${kind}: 预期源 ${label(expected)} 本轮失败过（${how}），下移到 ${label(observed)}（有失败记录）` };
  }
  return {
    ok: false,
    reason: `${kind}: observed=${label(observed)} ≠ 预期源 ${label(expected)}，且没有任何失败证据（可用却换源）`,
  };
}

/** 传输层失败在 out() 里会重试一次：请求数预算给这份重试留的余量 */
export const RETRY_SLACK = 1;

/**
 * 出网次数预算（单个 kind 的一条链）。
 * 档位按「observed 是否等于预期源」选：
 *   一致（这一步本应一次成功）→ [1, 1+retrySlack]（>2 即「撞满多家」，判红）；
 *   不一致（真换过源）→ [1, 1 + 2×(源数-1) + retrySlack]（每级下移允许一次尝试加一次重试）。
 */
export function requestBudget({ kind, requests, preferred = "", observed = "", registry = MARKET_SOURCES, retrySlack = RETRY_SLACK }) {
  const sources = registryView(kind, registry).map((s) => s.id);
  const expected = firstExpected(kind, preferred, registry);
  const sameTier = observed !== "" && observed === expected;
  const hi = sameTier ? 1 + retrySlack : 1 + 2 * Math.max(0, sources.length - 1) + retrySlack;
  const n = Number(requests);
  const ok = Number.isFinite(n) && n >= 1 && n <= hi;
  const why = sameTier
    ? `observed=${observed || "(空)"} == 预期源，本应一次成功，最多给重试留 ${retrySlack} 次 —— 撞多家即判红`
    : `observed=${observed || "(空)"} ≠ 预期源 ${expected || "(无)"}，按真换源放宽（${sources.length} 个源、每级一次尝试+一次重试）`;
  return { ok, lo: 1, hi, sameTier, reason: `${kind}: 实测 ${n} 次，允许区间 [1, ${hi}]（${why}）` };
}

/** 多 kind 叠加的预算（面板一轮里 depth+trend+kline 三条链的总出网数） */
export function requestBudgetMany({
  kinds,
  requests,
  preferred = {},
  observed = {},
  registry = MARKET_SOURCES,
  retrySlack = RETRY_SLACK,
}) {
  let lo = 0;
  let hi = 0;
  let allSameTier = true;
  const parts = [];
  for (const kind of kinds) {
    const b = requestBudget({ kind, requests: 0, preferred: preferred[kind] ?? "", observed: observed[kind] ?? "", registry, retrySlack });
    lo += b.lo;
    hi += b.hi;
    allSameTier = allSameTier && b.sameTier;
    parts.push(`${kind}[1,${b.hi}]`);
  }
  const n = Number(requests);
  const ok = Number.isFinite(n) && n >= lo && n <= hi;
  return {
    ok,
    lo,
    hi,
    allSameTier,
    reason: `${kinds.join("+")}: 实测 ${n} 次，允许区间 [${lo}, ${hi}]（${parts.join(" ")}${allSameTier ? "；三条链都命中预期源，应接近下限" : ""}）`,
  };
}
