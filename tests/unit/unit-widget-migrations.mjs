// 迁移冒烟（离线）：把插件的 widget.js 真的在 Worker 侧运行时里跑一遍。
//
// 为什么要它：四张迁移卡如果都靠 CDP 运行时套件取证，就得抢同一个调试端口与单实例锁，
// 等于串行。这个冒烟不开浏览器、不占端口、秒级，能抓住迁移中最常见的一类破 ——
// 残留 `document.*`（Worker 里必然 ReferenceError）、用了表外的标签/属性名（宿主那条门禁就是
// `isWidgetOp`，这里照它逐条过一遍）。**它抓不到视觉与交互**，那仍以各插件的运行时套件为准。
//
// 名单来源与生产同一处：`WIDGET_WORKER_MIGRATED`（PM 验收迁移卡时追加）。
// 插件作者想在台账之外先试自己那一个：`PET_WIDGET_SMOKE=com.pet.xxx`（逗号分隔）。
//
// 反向那半同样是指望：台账外的真实插件**必须**跑不起来。哪天冒烟对谁都绿，它就是空转了。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { WIDGET_WORKER_MIGRATED, isWidgetOp } from "../../src/runtime/widget-protocol.ts";
import { createWidgetRuntime } from "../../src/runtime/widget-worker.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGIONS = ["badge", "overlay", "settings"];
/** 仓库自带的四个示例插件（迁移对象就是它们） */
const REAL = ["com.pet.todo", "com.pet.agent-bridge", "com.pet.hr-ble", "com.pet.astock"];
/** 常驻基线：夹具那份是双 realm 写法，今天就该过 —— 它证明这套冒烟本身不是空转 */
const FIXTURE_DIR = join("tests", "fixtures", "l1-probe");

const extraIds = () =>
  (process.env.PET_WIDGET_SMOKE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const targets = () => [...new Set([...WIDGET_WORKER_MIGRATED, ...extraIds()])];

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(REPO, dir, "manifest.json"), "utf8"));
}

/** 替身宿主的回包：形状给最空的。真实套件里才有真数据，所以形状敏感的逻辑不靠本文件判。 */
const replyFor = (method) => (String(method).startsWith("agentHooks.") ? {} : null);

/** 在 Worker 侧运行时里跑一遍：返回 ops、越界 op、调用面外的方法名、以及失败原因 */
async function smoke(dir, region) {
  const entry = pathToFileURL(join(REPO, dir, "widget.js")).href;
  const manifest = manifestOf(dir);
  const ops = [];
  const badOps = [];
  const calls = [];
  let bootError = null;
  let booted = false;

  const runtime = createWidgetRuntime({
    post: (msg) => {
      if (msg.t === "ops") {
        for (const op of msg.ops) {
          ops.push(op);
          if (!isWidgetOp(op)) badOps.push(op);
        }
        return;
      }
      if (msg.t === "call") {
        calls.push(msg.method);
        // 逢 call 必回：真宿主怎么回，这里就怎么回，否则 mount 里的调用会把冒烟吊死
        queueMicrotask(() =>
          runtime.hostMessage({ t: "result", seq: msg.seq, ok: true, value: replyFor(msg.method) }),
        );
        return;
      }
      if (msg.t === "booted") booted = true;
      if (msg.t === "boot-failed") bootError = msg.error?.message ?? "未知失败";
    },
    loadEntry: () => import(entry),
  });

  await runtime.boot({
    t: "boot",
    pluginId: manifest.id,
    entryUrl: entry,
    region,
    permissions: manifest.permissions ?? [],
  });
  // 收尾让插件自己清定时器：留着的测试进程不退出，看起来像挂死而不是断言失败
  runtime.hostMessage({ t: "deactivate" });
  await new Promise((res) => setTimeout(res, 30));
  return { ops, badOps, calls, bootError, booted };
}

describe("常驻基线：夹具那份双 realm 写法必须跑得起来", () => {
  for (const region of REGIONS) {
    it(`夹具 widget 在 ${region} 区零越界`, async () => {
      const r = await smoke(FIXTURE_DIR, region);
      assert.equal(r.bootError, null, `挂载失败：${r.bootError}`);
      assert.equal(r.booted, true, "没有 booted 回执");
      assert.deepEqual(r.badOps, []);
      assert.ok(r.ops.length > 0, "一条 op 都没发，等于没渲染");
    });
  }
});

describe("台账内的插件必须能在 Worker realm 里跑起来", () => {
  const ids = targets();
  if (ids.length === 0) {
    it("（当前没有已迁移插件，也没有 PET_WIDGET_SMOKE 点名）", () => {
      assert.equal(ids.length, 0);
    });
  }
  for (const id of ids) {
    for (const region of REGIONS) {
      it(`${id} 在 ${region} 区跑得起来且不越界`, async () => {
        const r = await smoke(join("plugins", id), region);
        assert.equal(r.bootError, null, `挂载失败：${r.bootError}`);
        assert.equal(r.booted, true, "没有 booted 回执");
        assert.deepEqual(r.badOps, []);
        assert.ok(r.ops.length > 0, "一条 op 都没发，等于没渲染");
      });
    }
  }
});

describe("台账外的真实插件必须跑不起来（冒烟不是空转）", () => {
  for (const id of REAL.filter((x) => !targets().includes(x))) {
    it(`${id} 还没迁，Worker 里就该当场失败`, async () => {
      const r = await smoke(join("plugins", id), "badge");
      assert.notEqual(r.bootError, null, "未迁移的插件居然在 Worker realm 里跑起来了");
      assert.match(String(r.bootError), /document|window|localStorage|not defined/);
    });
  }
});
