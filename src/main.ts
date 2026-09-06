import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSpriteSet, FRAME_SIZE, type SpriteSet } from "./pet/sprites";
import { PetStateMachine, type PokeZone } from "./pet/state-machine";
import { pickLine, type LineState } from "./pet/dialogue";
import { initRuntime } from "./runtime/plugin-runtime";
import "./styles.css";

const canvas = document.querySelector<HTMLCanvasElement>("#pet-canvas")!;
const ctx = canvas.getContext("2d")!;
const bubble = document.querySelector<HTMLDivElement>("#pet-bubble")!;

function fitCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", fitCanvas);
fitCanvas();

let pet: PetStateMachine;
let spriteDrawSize = FRAME_SIZE; // 立绘实际绘制边长（CSS px）

/* ---------- 台词气泡（wm-pop 风格弹出） ---------- */
let bubbleTimer: number | undefined;
function say(text: string): void {
  if (!text) return;
  bubble.textContent = text;
  bubble.classList.add("show");
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => bubble.classList.remove("show"), 3600);
}

/* ---------- 交互：按住拖拽 vs 戳一戳（部位判定参考原项目 hit-zones） ---------- */
// 按下后移动超过阈值才启动系统级拖拽（拖拽会吞掉后续鼠标事件），
// 否则抬起视为「戳一戳」：按部位触发反应 + 台词气泡
const petWindow = getCurrentWindow();
let press: { x: number; y: number } | null = null;
let dragEngaged = false;

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  dragEngaged = false;
});

document.addEventListener("mousemove", (e) => {
  if (!press || dragEngaged) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 6) {
    dragEngaged = true;
    void petWindow.startDragging();
  }
});

document.addEventListener("mouseup", (e) => {
  const wasPress = press !== null;
  const wasDrag = dragEngaged;
  press = null;
  dragEngaged = false;
  if (!wasPress || wasDrag || e.button !== 0 || !pet) return;
  const zone = hitZone(e.clientY);
  const action = pet.poke(zone);
  const lineState: LineState | null =
    action === "greet" ? "wake" : (action as LineState);
  say(pickLine(lineState ?? "idle"));
});

function hitZone(clientY: number): PokeZone {
  const top = window.innerHeight / 2 - spriteDrawSize / 2;
  const ny = (clientY - top) / spriteDrawSize;
  if (ny > 0.8) return "tail";
  if (ny < 0.5) return "head";
  return "belly";
}

/* ---------- 夜间模式：22:00-7:00 待机换成夜晚姿势 ---------- */
function applyNightSchedule(sprites: SpriteSet): void {
  const apply = (): void => {
    const hour = new Date().getHours();
    const night = hour >= 22 || hour < 7;
    pet.setIdleFrame(night ? sprites.night?.[0] : sprites.idle?.[0]);
  };
  apply();
  window.setInterval(apply, 60_000);
}

let last = performance.now();

async function init(): Promise<void> {
  const sprites = await loadSpriteSet();
  const spriteSize = (sprites.idle?.[0]?.width ?? FRAME_SIZE) * SPRITE_SCALE;
  spriteDrawSize = spriteSize;
  pet = new PetStateMachine(sprites);
  pet.onSleep = () => say(pickLine("sleep"));
  applyNightSchedule(sprites);
  void initRuntime();
  requestAnimationFrame(tick);
  window.setTimeout(() => say(pickLine("greet")), 700);
  // 偶尔的待机碎碎念
  window.setInterval(() => {
    if (pet.action === "idle" && Math.random() < 0.4) say(pickLine("idle"));
  }, 45_000);
}

/** 立绘绘制缩放：窗口 360，角色视觉约 266px */
const SPRITE_SCALE = 0.74;

function tick(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  pet.update(dt);

  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  // 呼吸浮动（wm-breathe 的 canvas 版）
  const bob = Math.sin((now / 1000) * ((Math.PI * 2) / 3.4)) * 3;
  // 轻摆（wm-sway：±1.2°）
  const sway = Math.sin((now / 1000) * ((Math.PI * 2) / 2.6)) * (1.2 * Math.PI) / 180;
  // 姿势切换弹跳淡入（wm-pose-in 风格）
  const k = Math.min(1, (now - pet.lastSwitchAt) / 180);
  const pop = 1 + 0.05 * (1 - k);
  // 尾巴反应抖动（wm-shake）
  const shake = now < pet.shakeUntil ? Math.sin(now / 26) * 2.5 : 0;

  ctx.save();
  ctx.globalAlpha = 0.35 + 0.65 * k;
  ctx.translate(cx + shake, cy + bob);
  ctx.rotate(sway);
  ctx.scale(pop, pop);
  ctx.drawImage(pet.frame, -spriteDrawSize / 2, -spriteDrawSize / 2, spriteDrawSize, spriteDrawSize);
  ctx.restore();

  requestAnimationFrame(tick);
}

void init();
