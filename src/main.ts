import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSpriteSet, FRAME_SIZE, type SpriteSet } from "./pet/sprites";
import { PetStateMachine, type PokeZone } from "./pet/state-machine";
import { pickLine, type LineState } from "./pet/dialogue";
import { registerPetController } from "./pet/host";
import { installClickThrough } from "./pet/click-through";
import { installGameMode } from "./pet/game-mode";
import { initRuntime } from "./runtime/plugin-runtime";
import "./styles.css";

const canvas = document.querySelector<HTMLCanvasElement>("#pet-canvas")!;
const ctx = canvas.getContext("2d")!;
const bubble = document.querySelector<HTMLDivElement>("#pet-bubble")!;
const petWindow = getCurrentWindow();

/** 立绘绘制缩放：窗口 360，角色视觉约 266 CSS px */
const SPRITE_SCALE = 0.74;
/** 立绘在 CSS 坐标系里的边长。帧按 FRAME_SIZE×dpr 烘焙，绘制时按此边长贴图 */
const SPRITE_CSS = Math.round(FRAME_SIZE * SPRITE_SCALE);
/** 呼吸/轻摆/抖动的最大位移，脏矩形按它留边 */
const MOTION_MARGIN = 12;

let pet: PetStateMachine;
let sprites: SpriteSet;
let lastNight: boolean | null = null;

function fitCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** 立绘矩形（CSS px）——点击判定、点击穿透、气泡/徽标定位共用同一份几何 */
function spriteRect(): { left: number; top: number; size: number } {
  return {
    left: Math.round(window.innerWidth / 2 - SPRITE_CSS / 2),
    top: Math.round(window.innerHeight / 2 - SPRITE_CSS / 2),
    size: SPRITE_CSS,
  };
}

/** 把几何写进 CSS 变量，避免徽标/气泡各自硬编像素而互相漂移 */
function syncLayout(): void {
  const { left, top, size } = spriteRect();
  const style = document.documentElement.style;
  style.setProperty("--pet-size", `${size}px`);
  style.setProperty("--pet-left", `${left}px`);
  style.setProperty("--pet-badge-bottom", `${Math.round(window.innerHeight - (top + size * 0.6))}px`);
  style.setProperty("--pet-bubble-bottom", `${Math.round(window.innerHeight - top - 8)}px`);
}

/* ---------- 台词气泡（wm-pop 风格弹出） ---------- */
let bubbleTimer: number | undefined;
function say(text: string): void {
  if (!text) return;
  bubble.textContent = text;
  bubble.classList.add("show");
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => bubble.classList.remove("show"), 3600);
}

/* ---------- 交互：按住拖拽 vs 戳一戳 ---------- */
// 按下后移动超过阈值才启动系统级拖拽（拖拽会吞掉后续鼠标事件），
// 否则抬起视为「戳一戳」：按部位触发反应 + 台词气泡
let press: { x: number; y: number } | null = null;
let dragEngaged = false;

function insideSprite(clientX: number, clientY: number): boolean {
  const r = spriteRect();
  return clientX >= r.left && clientX <= r.left + r.size && clientY >= r.top && clientY <= r.top + r.size;
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  dragEngaged = false;
});

document.addEventListener("mousemove", (e) => {
  document.documentElement.classList.toggle("over-pet", insideSprite(e.clientX, e.clientY));
  if (!press || dragEngaged) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 6) {
    dragEngaged = true;
    void petWindow.startDragging();
  }
});

// 按下后指针移出窗口、或在窗口外抬起、或失焦：都必须复位，否则 press 会一直挂着
window.addEventListener("blur", resetPress);
document.addEventListener("mouseleave", resetPress);
document.addEventListener("mouseup", (e) => {
  const wasPress = press !== null;
  const wasDrag = dragEngaged;
  const clientX = e.clientX;
  const clientY = e.clientY;
  resetPress();
  if (!wasPress || wasDrag || e.button !== 0 || !pet) return;
  // 只认落在立绘范围内的一击（原来纵向一条带子无限宽，点窗口角落也会戳到角色）
  if (!insideSprite(clientX, clientY)) return;
  const action = pet.poke(hitZone(clientY));
  const lineState: LineState | null = action === "greet" ? "wake" : (action as LineState);
  say(pickLine(lineState ?? "idle"));
});

function resetPress(): void {
  press = null;
  dragEngaged = false;
}

function hitZone(clientY: number): PokeZone {
  const { top, size } = spriteRect();
  const ny = (clientY - top) / size;
  if (ny > 0.8) return "tail";
  if (ny < 0.5) return "head";
  return "belly";
}

/* ---------- 夜间模式：22:00-7:00 待机换成夜晚姿势 ---------- */
function applyNightSchedule(): void {
  const hour = new Date().getHours();
  const night = hour >= 22 || hour < 7;
  if (night === lastNight) return; // 状态没变就别重建 FramePlayer
  lastNight = night;
  pet.setIdleFrame(night ? sprites.night?.[0] : sprites.idle?.[0]);
}

/* ---------- 渲染循环 ---------- */
let last = performance.now();
let rafId = 0;

function tick(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  pet.update(dt);

  const { left, top, size } = spriteRect();
  const cx = left + size / 2;
  const cy = top + size / 2;
  // 呼吸浮动（wm-breathe 的 canvas 版）
  const bob = Math.sin((now / 1000) * ((Math.PI * 2) / 3.4)) * 3;
  // 轻摆（wm-sway：±1.2°）
  const sway = Math.sin((now / 1000) * ((Math.PI * 2) / 2.6)) * (1.2 * Math.PI) / 180;
  // 姿势切换弹跳淡入（wm-pose-in 风格）
  const k = Math.min(1, (now - pet.lastSwitchAt) / 180);
  const pop = 1 + 0.05 * (1 - k);
  // 尾巴反应抖动（wm-shake）
  const shake = now < pet.shakeUntil ? Math.sin(now / 26) * 2.5 : 0;

  // 脏矩形：立绘范围 + 位移余量。原来每帧清整窗（360²），其中大部分永远是透明空白
  const box = size / 2 + MOTION_MARGIN;
  ctx.clearRect(cx - box, cy - box, box * 2, box * 2);
  ctx.save();
  ctx.globalAlpha = 0.35 + 0.65 * k;
  ctx.translate(cx + shake, cy + bob);
  ctx.rotate(sway);
  if (k < 1) ctx.scale(pop, pop); // 弹跳结束后不再重采样
  ctx.drawImage(pet.frame, -size / 2, -size / 2, size, size);
  ctx.restore();

  rafId = requestAnimationFrame(tick);
}

let stopThrough: (() => void) | null = null;
let idleChat = 0;

/** 可见时才需要跑的辅助循环：hit-test 光标轮询 + 偶尔自言自语 */
function startAux(): void {
  if (!stopThrough) stopThrough = installClickThrough({ spriteRect, isDragging: () => dragEngaged });
  if (!idleChat) {
    idleChat = window.setInterval(() => {
      if (pet.action === "idle" && Math.random() < 0.4) say(pickLine("idle"));
    }, 45_000);
  }
}

function stopAux(): void {
  stopThrough?.();
  stopThrough = null;
  if (idleChat) {
    window.clearInterval(idleChat);
    idleChat = 0;
  }
}

/** 窗口最小化/隐藏时停掉动画，回到可见再续 */
function setRunning(running: boolean): void {
  if (running) {
    startAux();
    if (!rafId) {
      last = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  } else {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    // 隐藏时把光标轮询与闲聊定时器也掐掉：没人看见的东西不该还在花钱
    stopAux();
  }
}

async function rebakeForDpr(): Promise<void> {
  // 源图有缓存，这里只是按新的 dpr 重新烘焙，不重走网络
  sprites = await loadSpriteSet();
  pet.setSprites(sprites);
  lastNight = null;
  applyNightSchedule();
  fitCanvas();
}

/** matchMedia 的 once 监听只会响一次，响应后要按新的 dpr 重新挂一条 */
function watchDpr(): void {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener(
    "change",
    () => {
      void rebakeForDpr();
      watchDpr();
    },
    { once: true },
  );
}

async function init(): Promise<void> {
  fitCanvas();
  syncLayout();
  sprites = await loadSpriteSet();
  pet = new PetStateMachine(sprites);
  pet.onSleep = () => say(pickLine("sleep"));
  applyNightSchedule();

  registerPetController({
    react: (action) => pet.request(action),
    say: (text) => say(text),
  });

  void initRuntime();
  setRunning(true);
  void installGameMode({ pause: () => setRunning(false), resume: () => setRunning(true) });

  window.addEventListener("resize", () => {
    fitCanvas();
    syncLayout();
  });
  // dpr 变化（换显示器 / 改系统缩放）靠这条媒体查询感知，resize 事件不一定触发
  watchDpr();
  document.addEventListener("visibilitychange", () => setRunning(!document.hidden));
  window.setTimeout(() => say(pickLine("greet")), 700);
}

void init();
