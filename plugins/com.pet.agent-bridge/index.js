// Agent 桥：把编码 Agent 的会话状态映射成宠物反应。
//
// 数据源是宿主广播的 agent:state / agent:event —— Qoder hook 事件由 Rust 侧
// （services/agent.rs）落盘、归一化成会话状态后注入总线。本插件只是表现层：
// 不碰 hook 配置，不读写用户目录，也不发任何网络请求。
import { TOPIC_STATE, TOPIC_STATUS } from "./topics.js";

// 宿主会话状态词表 → 宠物动作。failed 不在其中：它在总状态里仍算「进行中」，
// 只能从 agent:event 的细粒度事件表现（见 onEvent）。
const ACTION_BY_STATE = {
  running: "walk",
  needs_input: "curious",
  completed: "greet",
};

function lineFor(state, tool) {
  if (state === "needs_input") return "这边需要你确认一下";
  if (state === "completed") return "刚才那轮跑完了";
  if (state === "failed") return tool ? `${tool} 失败了，回去看看` : "有一步失败了，回去看看";
  return null;
}

let ctx = null;
const unsubs = [];
let lastState = null;
let lastTool = null;
let seenCounter = -1;

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

async function onState(payload) {
  const state = typeof payload?.state === "string" ? payload.state : null;
  if (!state) return;
  // counter 由宿主递增，只认新的；没有 counter 时退回到状态名去重
  if (typeof payload.counter === "number") {
    if (payload.counter <= seenCounter) return;
    seenCounter = payload.counter;
  } else if (state === lastState) {
    return;
  }
  lastState = state;
  ctx.bus.publish(TOPIC_STATE, { state, counter: payload.counter ?? null });

  const action = ACTION_BY_STATE[state];
  if (!action) return;
  await ctx.pet.react(action);
  const line = lineFor(state, lastTool);
  if (line) await ctx.pet.say(line);
}

function onEvent(payload) {
  const phase = typeof payload?.phase === "string" ? payload.phase : "";
  const tool = typeof payload?.toolName === "string" ? payload.toolName.slice(0, 40) : "";
  if (phase !== "tool-failure" && phase !== "stop-failure") return;
  lastTool = tool || lastTool;
  // 失败在总状态里仍算「进行中」，所以它只能从细粒度事件上表现，不能等 agent:state
  void (async () => {
    try {
      await ctx?.pet.react("angry");
      await ctx?.pet.say(lineFor("failed", lastTool));
    } catch {
      /* 已停用 */
    }
  })();
}

export async function activate(context) {
  ctx = context;
  lastState = null;
  lastTool = null;
  seenCounter = -1;

  unsubs.push(ctx.bus.subscribe("agent:state", (p) => void onState(p)));
  unsubs.push(ctx.bus.subscribe("agent:event", (p) => onEvent(p)));
  status("已接管宿主 Agent 事件");
}

export async function deactivate() {
  for (const off of unsubs.splice(0)) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
  ctx = null;
}
