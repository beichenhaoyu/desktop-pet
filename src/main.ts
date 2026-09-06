import { getCurrentWindow } from "@tauri-apps/api/window";
import { buildSpriteSet, FRAME_SIZE } from "./pet/sprites";
import { PetStateMachine } from "./pet/state-machine";
import "./styles.css";

const canvas = document.querySelector<HTMLCanvasElement>("#pet-canvas")!;
const ctx = canvas.getContext("2d")!;

function fitCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", fitCanvas);
fitCanvas();

const pet = new PetStateMachine(buildSpriteSet(), window.innerWidth);

// 无边框拖拽：按住窗口任意处即可拖动宠物
document.addEventListener("mousedown", (e) => {
  if (e.button === 0) {
    void getCurrentWindow().startDragging();
  }
});

let last = performance.now();

function tick(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  pet.update(dt);

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.save();
  ctx.translate(window.innerWidth / 2 + pet.offsetX, window.innerHeight / 2);
  ctx.scale(pet.facing, 1);
  ctx.drawImage(pet.frame, -FRAME_SIZE / 2, -FRAME_SIZE / 2);
  ctx.restore();

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
