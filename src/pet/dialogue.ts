// 宠物台词库：按键位是 petdex 的九状态（外加唤醒），原来的 sleep/react 系列已取消。

import type { PetStateId } from "./petdex-states";

export type LineState = PetStateId | "wake";

const LINES: Partial<Record<LineState, string[]>> = {
  waving: ["我来找你啦～今天也一起加油吧✨", "在这儿呢，叫我干嘛？🎀"],
  jumping: ["哇哦！有动静！", "跳一下，证明我还醒着～"],
  failed: ["唔……这次不太顺利。", "别难过，我先蹲一会儿。"],
  waiting: ["Zzz……有单就叫醒我……🐑"],
  wake: ["呜哇！我醒着！刚刚只是在闭目养神！", "有单子吗？马上营业！🎀"],
  review: ["在看东西，别吵……👀", "让我想想。"],
  running: ["正在忙，稍等一下下！", "跑起来了～"],
  "running-left": ["往这边走两步。", "溜达溜达～"],
  "running-right": ["往那边走两步。", "走走停停，才有精神。"],
  idle: [
    "待机中……耳朵可没闲着，我听见 bug 在远处笑😼",
    "主人要是累了就戳戳我，免费解压，童叟无欺🫧",
    "今天风很轻，适合把待办也一起吹跑🌬️",
  ],
};

export function pickLine(state: LineState): string {
  const lines = LINES[state] ?? LINES.idle!;
  return lines[Math.floor(Math.random() * lines.length)] ?? "";
}
