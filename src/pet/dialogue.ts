// 宠物台词库：改写自 dsh-whale-musume 的 whale-moe-core 台词（MIT, © Sutera-Diffusus），
// 有删改；素材与台词的来源声明见 src/pet/assets/whale/README.md

export type LineState =
  | "greet"
  | "teasing"
  | "blush"
  | "angry"
  | "sleep"
  | "wake"
  | "idle";

const LINES: Record<LineState, string[]> = {
  greet: ["我来找你啦～今天也一起加油吧✨", "主人主人，鲸鱼娘已上线～🐋"],
  teasing: [
    "主人认真工作的样子，很好看哦。",
    "偷偷给你加一颗糖～",
    "鲸鱼娘什么都没说，只是嘴角有点压不住😏",
  ],
  blush: ["呀、突然戳这里干嘛啦……🥺", "才、才没有脸红呢！"],
  angry: ["尾巴不可以随便拉的哦！🐋💢", "再拽尾巴我真的要生气了！"],
  sleep: ["Zzz……有单就叫醒我……🐑"],
  wake: ["呜哇！我醒着！刚刚只是在闭目养神！", "有单子吗？鲸鱼娘马上营业！🎀"],
  idle: [
    "待机中……耳朵可没闲着，我听见 bug 在远处笑😼",
    "主人要是累了就戳戳我，免费解压，童叟无欺🫧",
    "今天风很轻，适合把待办也一起吹跑🌬️",
  ],
};

export function pickLine(state: LineState): string {
  const lines = LINES[state];
  return lines[Math.floor(Math.random() * lines.length)] ?? "";
}
