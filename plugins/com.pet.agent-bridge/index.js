// Agent 桥：把编码 Agent 的会话状态映射成宠物反应，并渲染一张常驻状态卡。
//
// 数据源是宿主广播的 agent:state / agent:event —— Qoder hook 事件由 Rust 侧
// （services/agent.rs）落盘、归一化后注入总线。本插件只是表现层：
// 不碰 hook 配置，不读写用户目录，也不发任何网络请求。
//
// 隐私口径：会话标题与命令摘要默认不显示，且**在 index.js 这一层就被剥掉**，
// 关掉开关时这些字符串根本不会进入 widget、也就不会落到 DOM 上。
import { TOPIC_CMD, TOPIC_STATE, TOPIC_STATUS } from "./topics.js";

// 宿主会话状态 → 宠物状态。词表就是 petdex 的九个状态，映射也照搬 petdex
// （packages/petdex-cli/src/hooks/bubble-runner.ts 的 stateForEvent）：
// 进行中=running、等确认=waiting、一轮结束=waving。
// 细粒度事件再按 phase 覆盖（见 stateForPhase），因为 petdex 的动画粒度本来就在工具调用这一层。
const ACTION_BY_STATE = {
  running: "running",
  needs_input: "waiting",
  completed: "waving",
  idle: "idle",
};

// petdex 把只读工具（Read|Grep|Glob）单独归到 review（「专注查看/思考」循环），其余工具算 running
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);

/** phase → petdex 状态。返回 null 表示这次事件不改变姿势 */
function stateForPhase(phase, toolName) {
  switch (phase) {
    case "pre": {
      const lower = (toolName || "").toLowerCase();
      return READ_ONLY_TOOLS.has(lower) ? "review" : "running";
    }
    case "subagent-start":
      return "running";
    case "user-prompt":
    case "session-start":
      return "jumping";
    case "tool-failure":
    case "stop-failure":
      return "failed";
    case "stop":
      return "waving";
    case "approval-request":
    case "notification":
      return "waiting";
    case "post":
    case "subagent-stop":
    case "session-end":
      return "idle";
    default:
      return null;
  }
}

const LABEL = {
  running: "正在执行",
  needs_input: "等你确认",
  completed: "这轮完成",
  idle: "待命",
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
let hideTimer = 0;
const HIDE_AFTER_DONE_MS = 3000;
let config = { showTitle: false, showDetail: false };
let latest = { state: "idle", steps: 0, title: "", toolName: "", detail: "" };
let overlayShown = false;

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

/** 剥掉未授权显示的字段 —— 开关关着时，敏感内容不出这一层 */
function publicView() {
  return {
    state: latest.state,
    label: LABEL[latest.state] ?? latest.state,
    steps: latest.steps,
    toolName: latest.toolName,
    title: config.showTitle ? latest.title : "",
    detail: config.showDetail ? latest.detail : "",
    showTitle: config.showTitle,
    showDetail: config.showDetail,
  };
}

function push() {
  ctx?.widget.update(publicView());
}

async function syncOverlay() {
  const want = latest.state !== "idle";
  if (want === overlayShown) return;
  overlayShown = want;
  try {
    if (want) await ctx.overlay.show({ placement: "above-pet", height: 104 });
    else await ctx.overlay.hide();
  } catch {
    overlayShown = !want; // 失败就退回原状态，下一次事件再试
  }
}

/** 一轮跑完后卡片再留 3 秒：让人看清「这轮完成」，然后自己收起，不用等宿主的 12 秒过期 */
function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(() => {
    hideTimer = 0;
    latest = { ...latest, state: "idle" };
    push();
    void syncOverlay();
  }, HIDE_AFTER_DONE_MS);
}

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

async function onState(payload) {
  const state = typeof payload?.state === "string" ? payload.state : null;
  if (!state) return;
  if (typeof payload.counter === "number") {
    if (payload.counter <= seenCounter) return;
    seenCounter = payload.counter;
  } else if (state === lastState) {
    return;
  }
  lastState = state;
  latest = {
    ...latest,
    state,
    steps: typeof payload.steps === "number" ? payload.steps : latest.steps,
    title: typeof payload.title === "string" && payload.title ? payload.title : latest.title,
  };
  ctx.bus.publish(TOPIC_STATE, { state, counter: payload.counter ?? null });
  if (state === "completed") scheduleHide();
  else cancelHide();
  push();
  await syncOverlay();

  const action = ACTION_BY_STATE[state];
  if (!action) return;
  await ctx.pet.react(action);
  const line = lineFor(state, null);
  if (line) await ctx.pet.say(line);
}

/** 还没拿到过总状态时，从事件 phase 推一个卡片用的状态（不影响宠物动作） */
function stateFromPhase(phase) {
  if (phase === "approval-request") return "needs_input";
  if (phase === "stop") return "completed";
  if (phase === "session-end") return "idle";
  if (["user-prompt", "session-start", "pre", "post", "subagent-start", "subagent-stop", "tool-failure", "stop-failure"].includes(phase)) {
    return "running";
  }
  return null;
}

async function onEvent(payload) {
  const phase = typeof payload?.phase === "string" ? payload.phase : "";
  const tool = typeof payload?.toolName === "string" ? payload.toolName.slice(0, 40) : "";
  const detail = typeof payload?.detail === "string" ? payload.detail.slice(0, 120) : "";
  if (phase === "tool-failure" || phase === "stop-failure") lastTool = tool || lastTool;
  latest = {
    ...latest,
    toolName: tool || latest.toolName,
    detail: detail || latest.detail,
    steps: typeof payload?.steps === "number" ? payload.steps : latest.steps,
    title: typeof payload?.title === "string" && payload.title ? payload.title : latest.title,
  };
  if (seenCounter < 0) {
    // 插件是在会话进行中才被启用的话，总状态下一条可能永远不来（宿主只在变化时广播）
    const derived = stateFromPhase(phase);
    if (derived && derived !== latest.state) {
      latest = { ...latest, state: derived };
      if (derived === "completed") scheduleHide();
      else cancelHide();
      void syncOverlay();
    }
  }
  push(); // 卡片要跟着每一次工具调用走，而不是只跟着状态翻转走

  const next = stateForPhase(phase, tool);
  // 工具收尾（post/subagent-stop）时若总状态仍是 running，就不把姿势打回 idle。
  // petdex 桌面端只有一个 /state 通道、post 确实回 idle；但这里工具是连续调用的，
  // 照搬会让宠物在两次调用之间闪一下 idle。一轮真正结束由 stop → waving 表达。
  if (!next || (next === "idle" && lastState === "running")) return;
  try {
    await ctx?.pet.react(next);
  } catch {
    /* 已停用 */
  }
  if (next === "failed") {
    try {
      await ctx?.pet.say(lineFor("failed", lastTool));
    } catch {
      /* 已停用 */
    }
  }
}

async function handleCmd(cmd) {
  if (cmd?.action === "sync") {
    push(); // 面板重新挂载时主动要一份当前数据（宿主的 `*:widget` 回灌是双保险）
    return;
  }
  if (cmd?.action !== "config") return;
  // 只覆盖消息里确实带来的字段：面板带着过期视图回来时，不该把另一个开关抹成 false
  config = {
    showTitle: cmd.showTitle === undefined ? config.showTitle : cmd.showTitle === true,
    showDetail: cmd.showDetail === undefined ? config.showDetail : cmd.showDetail === true,
  };
  try {
    await ctx.storage.set("config", config);
  } catch (err) {
    ctx.log?.("保存配置失败", err);
  }
  push();
  status(`显示设置已更新：标题 ${config.showTitle ? "开" : "关"}、命令摘要 ${config.showDetail ? "开" : "关"}`);
}

export async function activate(context) {
  stop();
  ctx = context;
  lastState = null;
  lastTool = null;
  seenCounter = -1;
  overlayShown = false;
  latest = { state: "idle", steps: 0, title: "", toolName: "", detail: "" };

  try {
    const saved = await ctx.storage.get("config");
    if (saved && typeof saved === "object") {
      config = { showTitle: saved.showTitle === true, showDetail: saved.showDetail === true };
    }
  } catch {
    /* 读不到就用默认值（默认不显示敏感内容） */
  }

  unsubs.push(ctx.bus.subscribe("agent:state", (p) => void onState(p)));
  unsubs.push(ctx.bus.subscribe("agent:event", (p) => void onEvent(p)));
  unsubs.push(ctx.bus.subscribe(TOPIC_CMD, (p) => void handleCmd(p)));
  push();
  status("已接管宿主 Agent 事件");
}

function stop() {
  cancelHide();
  for (const off of unsubs.splice(0)) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
}

export async function deactivate() {
  stop();
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 没开过就没有悬浮窗 */
  }
  ctx = null;
}
