// 序列帧播放器：按固定帧率推进当前动作的帧下标
export class FramePlayer {
  private index = 0;
  private acc = 0;

  constructor(
    private readonly frames: HTMLCanvasElement[],
    private readonly fps: number,
  ) {}

  get current(): HTMLCanvasElement {
    return this.frames[Math.min(this.index, this.frames.length - 1)];
  }

  update(dt: number): void {
    if (this.frames.length <= 1) return; // 单帧立绘无需推进
    this.acc += dt;
    const step = 1 / this.fps;
    while (this.acc >= step) {
      this.acc -= step;
      this.index = (this.index + 1) % this.frames.length;
    }
  }

  reset(): void {
    this.index = 0;
    this.acc = 0;
  }

  /** 随机起点（react 表情池每次随机挑一个） */
  randomize(): void {
    this.index = Math.floor(Math.random() * this.frames.length);
  }
}
