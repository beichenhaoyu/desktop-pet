import type { ActionName, SpriteSet } from "./sprites";
import { FramePlayer } from "./player";

interface StateDef {
  fps: number;
  duration: number; // 秒；到时切换到 next（或插播队列中的动作）
  next: ActionName | null; // null = 回 idle
  priority: number; // 数值越大越适合打断当前动作
}

// 宠物状态机：idle/walk 循环轮换，高优先级动作（sleep/react）可打断，
// 后续 pet:react 插件能力经由 request() 进入（架构核心设计 5）。
export class PetStateMachine {
  private defs: Partial<Record<ActionName, StateDef>> = {};
  private players: Partial<Record<ActionName, FramePlayer>> = {};
  private current: ActionName = "idle";
  private played = 0;
  private queued: ActionName | null = null;

  // 行走表现：宠物在窗口内左右踱步，渲染层读取 offsetX/facing
  offsetX = 0;
  facing: 1 | -1 = 1;
  private walkDir: 1 | -1 = 1;
  private readonly walkRange: number;

  constructor(
    sprites: SpriteSet,
    viewWidth: number,
  ) {
    // 序列帧宽 256，身体本体约 160px，留出摆动余量
    this.walkRange = Math.max(0, viewWidth - 190);
    this.register("idle", sprites.idle, { fps: 6, duration: 4, next: "walk", priority: 0 });
    this.register("walk", sprites.walk, { fps: 10, duration: 4.5, next: "idle", priority: 0 });
  }

  private register(
    action: ActionName,
    frames: HTMLCanvasElement[] | undefined,
    def: StateDef,
  ): void {
    if (!frames || frames.length === 0) return; // 该动作帧尚未提供
    this.defs[action] = def;
    this.players[action] = new FramePlayer(frames, def.fps);
  }

  /** 请求插播动作：优先级更高则立即打断，同级则等当前动作播完 */
  request(action: ActionName): void {
    const def = this.defs[action];
    if (!def) return;
    const cur = this.defs[this.current]!;
    if (def.priority > cur.priority) {
      this.switchTo(action);
    } else {
      this.queued = action;
    }
  }

  get frame(): HTMLCanvasElement {
    return this.players[this.current]!.current;
  }

  update(dt: number): void {
    this.played += dt;
    this.players[this.current]!.update(dt);

    if (this.current === "walk") {
      const speed = 55; // px/s
      this.offsetX += this.walkDir * speed * dt;
      if (this.offsetX > this.walkRange) {
        this.offsetX = this.walkRange;
        this.walkDir = -1;
      } else if (this.offsetX < -this.walkRange) {
        this.offsetX = -this.walkRange;
        this.walkDir = 1;
      }
      this.facing = this.walkDir;
    } else {
      this.offsetX = 0;
      this.facing = 1;
    }

    const def = this.defs[this.current]!;
    if (this.played >= def.duration) {
      const next = this.queued ?? def.next ?? "idle";
      this.queued = null;
      this.switchTo(next);
    }
  }

  private switchTo(action: ActionName): void {
    const target = this.players[action] ? action : "idle";
    this.current = target;
    this.played = 0;
    this.players[target]!.reset();
  }
}
