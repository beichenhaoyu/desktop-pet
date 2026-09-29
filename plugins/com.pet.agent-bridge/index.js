// Agent 桥：把编码 Agent 的会话状态变成宠物反应。
//
// 数据源用 petdex 已在 127.0.0.1:7777 上提供的只读端点 GET /state 与 GET /bubble
// （读侧不鉴权，写侧的 POST 才要 token）。刻意只做消费方：不绑这个端口、不碰
// ~/.qoder*/settings.json 里的 hook 槽位，所以与正在运行的 petdex 实例互不干扰，
// petdex 没启动时降级为静默待命。
import { TOPIC_BUBBLE, TOPIC_STATE, TOPIC_STATUS } from "./topics.js";

const BASE = "http://127.0.0.1:7777";
const POLL_MS = 800;
const BACKOFF_POLL_MS = 5000;
const ABSENT_AFTER = 4; // 连续失败约 3 秒后判定 petdex 不在

// petdex 的会话状态词表 → 宠物动作。idle 刻意不映射，免得压掉本体自己的默认态。
const ACTION_BY_STATE = {
  running: "walk",
  needs_input: "curious",
  completed: "greet",
  failed: "angry",
};

const LINE_BY_STATE = {
  needs_input: "这边需要你确认一下",
  completed: "刚才那轮跑完了",
  failed: "有一步失败了，回去看看",
};

let ctx = null;
let timer = null;
let stopped = true;
let busy = false; // 同一时刻只跑一轮，防止重复 activate 留下两条轮询链
let lastState = null;
let lastAgent = null;
let fails = 0;
let present = false;

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

/** 外部端点回来的字段一律按不可信输入处理：只认类型，并限长 */
function cleanString(value, max) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
}

async function getJson(path) {
  const res = await ctx.http.request(`${BASE}${path}`, { method: "GET" });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const parsed = JSON.parse(res.body);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function isDenied(err) {
  const msg = String(err?.message ?? err);
  return msg.includes("权限被拒绝") || msg.includes("授权被拒绝") || msg.includes("未授权访问");
}

function onPresent() {
  if (present) return;
  present = true;
  status("已连上 petdex，开始跟随 Agent 会话状态");
}

/** 未连上过的话保持静默：本机没装 petdex 时不该每 3 秒刷一条警告 */
function onAbsent(err) {
  if (!present) return;
  present = false;
  status(`已断开 petdex：${String(err?.message ?? err).slice(0, 80)}`, "warn");
}

async function readBubble(stateName) {
  try {
    const raw = await getJson("/bubble");
    const agent = cleanString(raw.agent_source, 24);
    const title = cleanString(raw.title, 96);
    lastAgent = agent ?? lastAgent;
    ctx.bus.publish(TOPIC_BUBBLE, {
      agent,
      title,
      state: stateName,
      busy: raw.busy === true,
    });
  } catch {
    // /bubble 只是补充上下文，读不到不影响状态跟随
  }
}

async function handleState(raw) {
  const stateName = cleanString(raw.state, 32);
  if (!stateName || stateName === lastState) return;
  lastState = stateName;
  const counter = typeof raw.counter === "number" ? raw.counter : null;
  ctx.bus.publish(TOPIC_STATE, { state: stateName, counter });

  const action = ACTION_BY_STATE[stateName];
  if (!action) return;
  await ctx.pet.react(action);
  await readBubble(stateName);
  const line = LINE_BY_STATE[stateName];
  if (line) await ctx.pet.say(lastAgent ? `${lastAgent} · ${line}` : line);
}

async function tick() {
  if (busy || !ctx) return;
  busy = true;
  try {
    const raw = await getJson("/state");
    fails = 0;
    onPresent();
    await handleState(raw);
  } catch (err) {
    if (isDenied(err)) {
      // 用户拒绝或撤销授权：继续轮询只会反复弹框/刷日志，直接收摊
      stop();
      status("权限被拒绝，Agent 桥已停止。可在设置窗重新授权。", "error");
      return;
    }
    fails += 1;
    if (fails === ABSENT_AFTER) onAbsent(err);
  } finally {
    busy = false;
    // 连不上就退避：本机没装 petdex 时，每 800ms 一次注定失败的请求纯属浪费
    schedule(present ? POLL_MS : BACKOFF_POLL_MS);
  }
}

function schedule(ms) {
  if (stopped) return;
  timer = setTimeout(() => {
    void tick();
  }, ms);
}

function stop() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export async function activate(context) {
  stop(); // 清掉可能残留的上一轮轮询链
  ctx = context;
  stopped = false;
  lastState = null;
  lastAgent = null;
  fails = 0;
  busy = false;
  present = false;
  void tick();
}

export async function deactivate() {
  stop();
  ctx = null;
}
