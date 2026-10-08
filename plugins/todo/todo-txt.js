// todo.txt 约定的最小解析/序列化。
// 一行一条：`(A) 2016-05-04 写周报 due:2016-05-10 @工作 +老板 x:2016-05-06`
// 只借它的字段形状（优先级 / 创建日 / 完成日 / @项目 / +上下文 / key:value），
// 存储仍走插件自己的隔离存储 —— 将来若要读写用户本机 todo.txt，
// 需要给插件体系加 fs 能力，那是本体的改动，这里刻意不做。

const PRIORITY = /^\(([A-Z])\)\s+/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseLine(raw) {
  let rest = String(raw ?? "").trim();
  const task = {
    done: false,
    priority: null,
    created: null,
    completed: null,
    text: "",
    contexts: [],
    projects: [],
    meta: {},
  };
  if (!rest) return task;

  const pri = PRIORITY.exec(rest);
  if (pri) {
    task.priority = pri[1];
    rest = rest.slice(pri[0].length);
  }
  const head = rest.slice(0, 10);
  if (DATE.test(head)) {
    task.created = head;
    rest = rest.slice(10).trimStart();
  }

  const words = [];
  for (const token of rest.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith("+")) task.contexts.push(token.slice(1));
    else if (token.startsWith("@")) task.projects.push(token.slice(1));
    else if (/^(\w+):(\S+)$/.test(token)) {
      const [, key, value] = /^(\w+):(\S+)$/.exec(token);
      task.meta[key] = value;
    } else words.push(token);
  }
  // 完成标记 x: 允许出现在任意位置，取出来当完成日
  if (typeof task.meta.x === "string") {
    task.done = true;
    if (DATE.test(task.meta.x)) task.completed = task.meta.x;
    delete task.meta.x;
  }
  task.text = words.join(" ");
  return task;
}

export function formatLine(task) {
  const parts = [];
  if (task.done) parts.push(`x:${task.completed || today()}`);
  else if (task.priority) parts.push(`(${task.priority})`);
  if (task.created) parts.push(task.created);
  parts.push(String(task.text ?? "").replace(/\s+/g, " ").trim());
  for (const [key, value] of Object.entries(task.meta ?? {})) parts.push(`${key}:${value}`);
  for (const c of task.contexts ?? []) parts.push(`+${c}`);
  for (const p of task.projects ?? []) parts.push(`@${p}`);
  return parts.filter(Boolean).join(" ");
}

/** 本地日期的 YYYY-MM-DD（不用 toISOString：UTC 会让晚上生成前一天的日期） */
export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 到期判定：逾期 < 今天到期 < 有优先级 < 无优先级；没有 due 的排在最后 */
export function dueRank(task) {
  const due = task.meta?.due;
  if (!DATE.test(due ?? "")) return 4;
  if (due < today()) return 0;
  if (due === today()) return 1;
  return 2;
}

/** 订阅方拿 open[0] 当「下一个到期」，所以同档内必须先按到期日排，
 *  否则 rank 2（将来到期）里谁是第一个取决于插入顺序，报出来的日期可能不是最近的 */
export function sortOpen(tasks) {
  return tasks
    .filter((t) => !t.done)
    .slice()
    .sort(
      (a, b) =>
        dueRank(a) - dueRank(b) ||
        dueOf(a).localeCompare(dueOf(b)) ||
        (a.priority ?? "Z").localeCompare(b.priority ?? "Z"),
    );
}

function dueOf(task) {
  const due = task.meta?.due;
  return DATE.test(due ?? "") ? due : "9999-12-31";
}
