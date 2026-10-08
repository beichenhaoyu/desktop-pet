// 序列帧播放器：按固定间隔推进当前状态的帧下标。
// 间隔来自 petdex 状态表：整行时长 / 该行帧数。
import type { SpriteFrame } from "./sprites";

export class FramePlayer {
  private index = 0;
  private acc = 0;

  constructor(
    private readonly frames: SpriteFrame[],
    private readonly interval: number,
  ) {}

  get current(): SpriteFrame {
    return this.frames[Math.min(this.index, this.frames.length - 1)];
  }

  update(dt: number): void {
    if (this.frames.length <= 1) return; // 单帧无需推进
    this.acc += dt;
    while (this.acc >= this.interval) {
      this.acc -= this.interval;
      this.index = (this.index + 1) % this.frames.length;
    }
  }

  reset(): void {
    this.index = 0;
    this.acc = 0;
  }
}
