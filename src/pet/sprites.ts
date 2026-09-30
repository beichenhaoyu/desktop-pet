// 精灵来源只有一个：Petdex 画廊下载的图集（8 列 × 9/11 行、单元格 192×208）。
// 本模块负责把一张图集切成九个状态的多帧序列，帧按 devicePixelRatio 烘焙成正方形画布，
// 渲染层继续以 CSS 边长 1:1 贴图。图集缺失或尺寸不被识别时退回程序生成的 idle 帧，
// 保证窗口不会是空白的。

import {
  PET_STATES,
  SPRITE_COLUMNS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  detectSpriteAtlas,
} from "./petdex-states";
import type { PetStateId } from "./petdex-states";

export type { PetStateId };
/** 状态词表完全等同 petdex：原来的 12 个自造状态（walk/greet/sleep/react/…）已取消 */
export type ActionName = PetStateId;

export type SpriteSet = Partial<Record<ActionName, HTMLCanvasElement[]>>;

/** 帧烘焙成的正方形画布边长（CSS px），乘以 dpr 得到实际像素 */
export const FRAME_SIZE = 360;

let bakeScale = 1;

function bakeSize(): number {
  return Math.round(FRAME_SIZE * bakeScale);
}

/** 归一化 dpr：小数倍缩放（125%/150%）也照实烘，避免再被采样一次 */
export function deviceScale(): number {
  return Math.max(1, window.devicePixelRatio || 1);
}

/** 已解码的图集源图：DPI 变化重新烘焙时不必再走一次解码 */
const atlasCache = new Map<string, HTMLImageElement>();

/**
 * 从图集 URL 装载九个状态的帧序列。
 * `scale` 省略时用当前 devicePixelRatio —— 换显示器/改缩放后带新 scale 再调一次即可只重烘焙。
 * URL 由宿主 petskin 协议给出（`http://petskin.localhost/<slug>/sprite.webp`）。
 * url 为空（还没有任何皮肤）或图集不被识别时，退回程序生成的 idle 帧。
 */
export async function loadSpriteSet(url: string, scale = deviceScale()): Promise<SpriteSet> {
  bakeScale = scale;
  if (!url) return buildProceduralSpriteSet();
  try {
    const img = await loadAtlas(url);
    const set = sliceAtlas(img);
    if (!set) throw new Error(`不是受支持的 petdex 图集: ${img.naturalWidth}x${img.naturalHeight}`);
    return set;
  } catch (err) {
    console.warn("[pet] 图集加载失败，退回程序生成占位帧", err);
    return buildProceduralSpriteSet();
  }
}

/** 图集源：真机是解码后的 <img>，回归里可以直接喂一张合成用的 canvas */
export type AtlasSource = HTMLImageElement | HTMLCanvasElement;

function sourceSize(source: AtlasSource): { width: number; height: number } {
  return source instanceof HTMLCanvasElement
    ? { width: source.width, height: source.height }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

/** 按当前 dpr 重新烘焙一张已解码的图集；尺寸不被识别时返回 null */
export function sliceAtlas(img: AtlasSource): SpriteSet | null {
  const { width: sw, height: sh } = sourceSize(img);
  const layout = detectSpriteAtlas(sw, sh);
  if (!layout) return null;
  const cellW = sw / SPRITE_COLUMNS;
  const cellH = sh / layout.rows;
  // petdex 单元格是 192×208（比宽更高），烘焙画布是正方形：按短边等比放入，横向留边，
  // 这样点击判定/气泡定位仍能沿用正方形几何，不必为每个状态另算一套矩形
  const size = bakeSize();
  const fit = Math.min(size / cellW, size / cellH);
  const dw = cellW * fit;
  const dh = cellH * fit;
  const dx = (size - dw) / 2;
  const dy = (size - dh) / 2;

  const set: SpriteSet = {};
  for (const state of PET_STATES) {
    const frames: HTMLCanvasElement[] = [];
    for (let col = 0; col < state.frames; col++) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, col * cellW, state.row * cellH, cellW, cellH, dx, dy, dw, dh);
      frames.push(canvas);
    }
    set[state.id] = frames;
  }
  return set;
}

export function loadAtlas(url: string): Promise<HTMLImageElement> {
  const cached = atlasCache.get(url);
  if (cached && cached.complete) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      atlasCache.set(url, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`图集加载失败: ${url}`));
    img.src = url;
  });
}

/** 已经解码过的图集 URL（只读诊断面）：回归用它确认换装确实在宠物窗里发生了 */
export function decodedAtlases(): string[] {
  return [...atlasCache.keys()];
}

/* ================= 程序生成兜底（仅供 idle） ================= */

// 兜底宠物的原始绘制尺寸
const PROCEDURAL_SIZE = 256;

/** 只生成 idle 一个状态的呼吸帧：图集不可用时的最后防线，不提供其余八个状态 */
export function buildProceduralSpriteSet(): SpriteSet {
  return {
    idle: Array.from({ length: 6 }, (_, i) => scaleToFrame(drawProceduralFrame(i))),
  };
}

function drawProceduralFrame(i: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = PROCEDURAL_SIZE;
  canvas.height = PROCEDURAL_SIZE;
  const ctx = canvas.getContext("2d")!;

  const t = (i / 6) * Math.PI * 2;
  const bodyDy = Math.sin(t) * 2;
  const squash = 1 + Math.sin(t) * 0.02;

  ctx.translate(PROCEDURAL_SIZE / 2, PROCEDURAL_SIZE / 2);
  ctx.translate(0, bodyDy);

  const bodyY = 8;
  const rx = 78;
  const ry = rx * squash;

  const body = ctx.createRadialGradient(-24, bodyY - 28, 8, 0, bodyY, rx + 6);
  body.addColorStop(0, "#ffc078");
  body.addColorStop(1, "#f5923e");
  ctx.fillStyle = body;
  ellipse(ctx, 0, bodyY, rx, ry);

  const eyeY = bodyY - 18;
  if (i === 5) {
    ctx.strokeStyle = "#5b3a12";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    for (const ex of [-28, 28]) {
      ctx.beginPath();
      ctx.moveTo(ex - 10, eyeY);
      ctx.lineTo(ex + 10, eyeY);
      ctx.stroke();
    }
  } else {
    for (const ex of [-28, 28]) {
      ctx.fillStyle = "#fff";
      ellipse(ctx, ex, eyeY, 14, 15);
      ctx.fillStyle = "#40270a";
      ellipse(ctx, ex + 4, eyeY + 2, 7, 8);
      ctx.fillStyle = "#fff";
      ellipse(ctx, ex + 6, eyeY - 2, 2.5, 2.5);
    }
  }

  ctx.fillStyle = "rgba(255, 120, 90, 0.45)";
  ellipse(ctx, -46, bodyY + 6, 10, 6);
  ellipse(ctx, 46, bodyY + 6, 10, 6);

  ctx.strokeStyle = "#5b3a12";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, bodyY + 8, 18, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  return canvas;
}

/** 把 256 的程序帧统一到当前烘焙边长，保证两条路径帧尺寸一致 */
function scaleToFrame(source: HTMLCanvasElement): HTMLCanvasElement {
  const size = bakeSize();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // 原来 256 的内容摆在 360 画布里约占 71%，缩放后保持同样的视觉占比
  const content = Math.round((size * PROCEDURAL_SIZE) / FRAME_SIZE);
  const offset = Math.round((size - content) / 2);
  ctx.drawImage(source, offset, offset, content, content);
  return canvas;
}

function ellipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

export { SPRITE_FRAME_HEIGHT, SPRITE_FRAME_WIDTH };
