// 序列帧播放器：按固定帧率推进当前动作的帧下标
export class FramePlayer {
  private index = 0;
  private acc = 0;

  constructor(
    private readonly frames: HTMLCanvasElement[],
    private readonly fps: number,
  ) {}

  get current(): HTMLCanvasElement {
    return this.frames[this.index];
  }

  update(dt: number): void {
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
}
