import type { ActionName, SpriteSet } from "./sprites";
import { FramePlayer } from "./player";

interface StateDef {
  duration: number; // 秒；到时按规则切换
  next: ActionName | null; // null = 回 idle
  priority: number; // 数值越大越适合打断当前动作
  randomStart?: boolean; // 进入时随机帧（react 表情池）
}

/** 无交互多久进入睡觉（参考原项目 AFK_MS = 180s） */
const AFK_SECONDS = 180;
/** idle 结束时随机切「好奇」小动作的概率 */
const CURIOUS_CHANCE = 0.35;

export type PokeZone = "head" | "belly" | "tail";

// 宠物状态机（交互模型参考 dsh-whale-musume whale-moe-core）：
// - 原地待机：呼吸/轻摆由渲染层负责，状态机只做姿势切换
// - idle 到时随机切「好奇」小动作
// - poke(部位) → 摸头/戳肚子/拉尾巴 三种反应（渲染层配台词气泡）
// - 3 分钟无交互 → 睡觉；任何交互唤醒
// - react 为插件预留的插播队列入口（pet:react）
export class PetStateMachine {
  private defs: Partial<Record<ActionName, StateDef>> = {};
  private players: Partial<Record<ActionName, FramePlayer>> = {};
  private current: ActionName = "idle";
  private played = 0;
  private queued: ActionName | null = null;
  private sinceInteraction = 0;

  /** 最近一次姿势切换的时间戳（渲染层做 pose-in 弹跳淡入） */
  lastSwitchAt = 0;
  /** 尾巴反应的抖动截止时间戳（渲染层做 wm-shake 式位移） */
  shakeUntil = 0;
  /** 进入睡觉时回调（渲染层配台词） */
  onSleep?: () => void;

  constructor(sprites: SpriteSet) {
    this.register("idle", sprites.idle, { duration: 9, next: null, priority: 0 });
    this.register("greet", sprites.greet, { duration: 2.6, next: "idle", priority: 1 });
    this.register("curious", sprites.curious, { duration: 2.4, next: "idle", priority: 1 });
    this.register("sleep", sprites.sleep, { duration: 1e9, next: null, priority: 5 });
    this.register("teasing", sprites.teasing, { duration: 2.4, next: "idle", priority: 10 });
    this.register("blush", sprites.blush, { duration: 2.4, next: "idle", priority: 10 });
    this.register("angry", sprites.angry, { duration: 2.4, next: "idle", priority: 10 });
    this.register("react", sprites.react, {
      duration: 2.2,
      next: null,
      priority: 10,
      randomStart: true,
    });
  }

  private register(
    action: ActionName,
    frames: HTMLCanvasElement[] | undefined,
    def: StateDef,
  ): void {
    if (!frames || frames.length === 0) return; // 该动作帧尚未提供
    this.defs[action] = def;
    this.players[action] = new FramePlayer(frames, 1);
  }

  /** 请求插播动作：优先级更高则立即打断，同级则排队等当前动作结束 */
  request(action: ActionName): void {
    this.sinceInteraction = 0;
    const def = this.defs[action];
    if (!def) return;
    const cur = this.defs[this.current]!;
    if (def.priority > cur.priority || this.current === "sleep") {
      this.switchTo(action);
    } else {
      this.queued = action;
    }
  }

  /**
   * 摸头/戳肚子/拉尾巴（部位判定参考原项目 hit-zones）。
   * 睡觉中任何poke都会先唤醒（切 greet，由渲染层配 wake 台词）。
   */
  poke(zone: PokeZone): ActionName {
    this.sinceInteraction = 0;
    if (this.current === "sleep") {
      this.switchTo("greet");
      return "greet";
    }
    const action: ActionName =
      zone === "head" ? "teasing" : zone === "belly" ? "blush" : "angry";
    if (zone === "tail") this.shakeUntil = performance.now() + 320;
    this.switchTo(action);
    return action;
  }

  /** 夜间模式：把 idle 立绘换成夜晚姿势 */
  setIdleFrame(frame: HTMLCanvasElement | undefined): void {
    if (!frame) return;
    this.players.idle = new FramePlayer([frame], 1);
    if (this.current === "idle") this.players.idle.reset();
  }

  get frame(): HTMLCanvasElement {
    return this.players[this.current]!.current;
  }

  get action(): ActionName {
    return this.current;
  }

  update(dt: number): void {
    this.played += dt;
    this.sinceInteraction += dt;

    // 挂机检测：非睡觉状态下 3 分钟无交互 → 睡觉
    if (
      this.current !== "sleep" &&
      this.current !== "react" &&
      this.sinceInteraction >= AFK_SECONDS
    ) {
      this.switchTo("sleep");
      this.onSleep?.();
    }

    this.players[this.current]!.update(dt);

    const def = this.defs[this.current]!;
    if (this.played >= def.duration) {
      let next: ActionName;
      if (this.current === "idle") {
        // idle 循环：随机切「好奇」小动作，或继续待机
        next =
          Math.random() < CURIOUS_CHANCE && this.players.curious ? "curious" : "idle";
      } else {
        next = this.queued ?? def.next ?? "idle";
        this.queued = null;
      }
      this.switchTo(next);
    }
  }

  private switchTo(action: ActionName): void {
    const target = this.players[action] ? action : "idle";
    this.current = target;
    this.played = 0;
    const player = this.players[target]!;
    player.reset();
    if (this.defs[target]?.randomStart) player.randomize();
    this.lastSwitchAt = performance.now();
  }
}
