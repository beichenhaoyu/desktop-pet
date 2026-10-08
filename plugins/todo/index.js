// 待办插件主逻辑，运行在宠物窗上下文。
// 数据只存插件自己的隔离存储（宿主按 id 分目录），不碰用户本机文件。
// 清单变化 → 广播标准 topic `todo:changed`；界面数据一律经 ctx.widget.update
// 推到 `<id>:widget`，面板重新挂载时由宿主回灌，所以设置面板能显示当前状态。
import { TOPIC_CHANGED, TOPIC_CMD, TOPIC_STATUS } from "./topics.js";
import { formatLine, parseLine, sortOpen, today } from "./todo-txt.js";

let ctx = null;
let tasks = [];
let config = { card: false, remind: true };
let notified = {}; // { 任务 id: 已提醒过的日期 }，一天最多提醒一次
let timer = 0;
const unsubs = [];

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

async function persist() {
  try {
    await ctx.storage.set("tasks", tasks);
    await ctx.storage.set("config", config);
    await ctx.storage.set("notified", notified);
  } catch (err) {
    ctx?.log?.("保存待办失败", err);
  }
}

/** 推给各界面的视图：只给未完成的、最多 20 条，附一条 todo.txt 原文方便核对 */
function pushState() {
  const open = sortOpen(tasks);
  ctx?.widget.update({
    today: today(),
    config,
    openCount: open.length,
    doneCount: tasks.filter((t) => t.done).length,
    tasks: open.slice(0, 20).map((t) => ({ ...t, line: formatLine(t) })),
  });
}

function emitChanged() {
  const open = sortOpen(tasks);
  ctx?.bus.publish(TOPIC_CHANGED, {
    open: open.length,
    total: tasks.length,
    nextDue: open[0]?.meta?.due ?? null,
    nextText: open[0]?.text ?? "",
  });
}

/** 同步桌面卡片：开关开着且有未完成项才显示 */
async function syncCard() {
  const want = config.card === true && sortOpen(tasks).length > 0;
  try {
    if (want) await ctx.overlay.show({ placement: "above-pet", height: 176 });
    else await ctx.overlay.hide();
  } catch (err) {
    ctx?.log?.("桌面卡片切换失败", err);
  }
}

/** 到期检查：逾期与今天到期的各提醒一次（按日去重），并让宠物有反应 */
async function checkDue(force = false) {
  if (!config.remind) return;
  const now = today();
  let fired = 0;
  for (const task of sortOpen(tasks)) {
    const due = task.meta?.due;
    if (!due || due > now) continue;
    if (!force && notified[task.id] === now) continue;
    const overdue = due < now;
    notified[task.id] = now;
    fired += 1;
    await ctx.notify.show(overdue ? "待办已逾期" : "待办今天到期", formatLine(task));
    await ctx.pet.react(overdue ? "failed" : "waiting");
    await ctx.pet.say(overdue ? `「${task.text}」已经逾期了……` : `「${task.text}」今天到期哦`);
  }
  if (fired > 0) await persist();
}

async function handleCmd(cmd) {
  if (!cmd || typeof cmd !== "object") return;
  switch (cmd.action) {
    case "sync":
      pushState();
      return;
    case "add": {
      const raw = String(cmd.text ?? "").trim();
      if (!raw) {
        status("先写点什么再添加", "error");
        return;
      }
      const parsed = parseLine(raw);
      if (!parsed.text && !parsed.priority) {
        status("这条里没有可显示的文字", "error");
        return;
      }
      tasks.push({ ...parsed, id: newId() });
      await afterChange(`已添加：${parsed.text}`);
      break;
    }
    case "toggle": {
      const task = tasks.find((t) => t.id === cmd.id);
      if (!task) return;
      task.done = cmd.done === true;
      task.completed = task.done ? today() : null;
      if (task.done) {
        delete notified[task.id];
        await ctx.pet.react("jumping");
        await ctx.pet.say(`「${task.text}」搞定！🎉`);
      }
      await afterChange(task.done ? `已完成：${task.text}` : `重新打开：${task.text}`);
      break;
    }
    case "remove": {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== cmd.id);
      if (tasks.length !== before) {
        delete notified[cmd.id];
        await afterChange("已删除一条");
      }
      break;
    }
    case "clearDone": {
      const removed = tasks.filter((t) => t.done).length;
      tasks = tasks.filter((t) => !t.done);
      await afterChange(removed > 0 ? `已清掉 ${removed} 条完成项` : "没有可清的完成项");
      break;
    }
    case "config": {
      if (cmd.card !== undefined) config.card = cmd.card === true;
      if (cmd.remind !== undefined) config.remind = cmd.remind === true;
      await persist();
      pushState();
      await syncCard();
      status(`桌面卡片 ${config.card ? "开" : "关"}、到期提醒 ${config.remind ? "开" : "关"}`);
      break;
    }
    default:
      status(`未知指令: ${String(cmd.action)}`, "error");
  }
}

async function afterChange(note) {
  await persist();
  pushState();
  emitChanged();
  await syncCard();
  if (note) status(note, "ok");
}

export async function activate(context) {
  ctx = context;
  unsubs.push(ctx.bus.subscribe(TOPIC_CMD, (p) => void handleCmd(p)));

  for (const [key, fallback] of [
    ["tasks", []],
    ["config", config],
    ["notified", {}],
  ]) {
    try {
      const saved = await ctx.storage.get(key);
      if (Array.isArray(saved) && key === "tasks") tasks = saved.filter((t) => t && typeof t.id === "string");
      else if (saved && typeof saved === "object") {
        if (key === "config") config = { ...config, ...saved };
        if (key === "notified") notified = saved;
      }
    } catch (err) {
      ctx.log?.(`读取 ${key} 失败`, err);
    }
  }

  pushState();
  emitChanged();
  await syncCard();
  await checkDue();
  timer = setInterval(() => void checkDue(), 60_000);
  status(`待办已就绪：${sortOpen(tasks).length} 项未完成`);
}

export async function deactivate() {
  if (timer) clearInterval(timer);
  timer = 0;
  for (const off of unsubs.splice(0)) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 没开过就没有卡片 */
  }
  ctx = null;
}
