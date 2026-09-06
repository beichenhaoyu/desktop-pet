// 宠物精灵：优先加载鲸鱼娘立绘（assets/whale/，来源 dsh-whale-musume，MIT，
// 详见 assets/whale/README.md），加载失败时回退到程序生成的占位宠物。
// 立绘为单帧状态图：动感由状态机动作切换 + 渲染层呼吸浮动提供。
// 美术序列帧（真正的多帧动画）就绪后，替换 loadSpriteSet 的帧来源即可，
// 播放器与状态机接口不变。

import idleUrl from "./assets/whale/idle.webp";
import greetUrl from "./assets/whale/greet.webp";
import sleepUrl from "./assets/whale/sleep.webp";
import runUrl from "./assets/whale/run.webp";
import curiousUrl from "./assets/whale/curious.webp";
import teasingUrl from "./assets/whale/teasing.webp";
import angryUrl from "./assets/whale/angry.webp";
import nightUrl from "./assets/whale/night.webp";
import reactWinkUrl from "./assets/whale/react-wink.webp";
import reactBlushUrl from "./assets/whale/react-blush.webp";
import reactCelebrateUrl from "./assets/whale/react-celebrate.webp";
import reactShockUrl from "./assets/whale/react-shock.webp";

export type ActionName =
  | "idle"
  | "walk"
  | "greet"
  | "sleep"
  | "react"
  | "curious"
  | "teasing"
  | "blush"
  | "angry"
  | "night";

export type SpriteSet = Partial<Record<ActionName, HTMLCanvasElement[]>>;

/** 立绘统一缩放到的正方形画布尺寸 */
export const FRAME_SIZE = 360;

// 兜底程序宠物的原始绘制尺寸
const PROCEDURAL_SIZE = 256;

const POSE_URLS: Array<[ActionName, string]> = [
  ["idle", idleUrl],
  ["greet", greetUrl],
  ["sleep", sleepUrl],
  ["walk", runUrl], // 兜底宠物仍保留踱步帧；鲸鱼娘不注册该动作
  ["curious", curiousUrl],
  ["teasing", teasingUrl],
  ["angry", angryUrl],
  ["night", nightUrl],
];
const REACT_URLS = [reactWinkUrl, reactBlushUrl, reactCelebrateUrl, reactShockUrl];

/** 加载鲸鱼娘立绘；任一失败则整体回退程序生成 */
export async function loadSpriteSet(): Promise<SpriteSet> {
  try {
    const frames = await Promise.all(
      POSE_URLS.map(async ([action, url]) => {
        const img = await loadImage(url);
        return [action, await toFrame(img)] as const;
      }),
    );
    const reactFrames = await Promise.all(
      REACT_URLS.map(async (url) => toFrame(await loadImage(url))),
    );
    const set: SpriteSet = {};
    for (const [action, canvas] of frames) {
      set[action] = [canvas];
    }
    set.react = reactFrames;
    set.blush = [reactFrames[1]]; // 摸肚子反应与 react 表情共用 blush 立绘
    return set;
  } catch (err) {
    console.warn("[pet] 立绘加载失败，回退程序生成占位宠物", err);
    return buildProceduralSpriteSet();
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片加载失败: ${url}`));
    img.src = url;
  });
}

async function toFrame(img: HTMLImageElement): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_SIZE;
  canvas.height = FRAME_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, FRAME_SIZE, FRAME_SIZE);
  return canvas;
}

/* ================= 程序生成占位宠物（兜底） ================= */

interface Pose {
  bodyDy: number;
  squash: number;
  legSwing: number;
  lean: number;
  blink: boolean;
}

export function buildProceduralSpriteSet(): SpriteSet {
  const frames = (pose: (i: number) => Pose) =>
    Array.from({ length: 8 }, (_, i) => scaleToFrame(drawProceduralFrame(pose(i))));
  return {
    idle: frames(idlePose),
    walk: frames(walkPose),
  };
}

function idlePose(i: number): Pose {
  const t = (i / 8) * Math.PI * 2;
  return {
    bodyDy: Math.sin(t) * 2,
    squash: 1 + Math.sin(t) * 0.02,
    legSwing: 0,
    lean: 0,
    blink: i === 5,
  };
}

function walkPose(i: number): Pose {
  const t = (i / 8) * Math.PI * 2;
  return {
    bodyDy: -Math.abs(Math.sin(t)) * 5,
    squash: 1,
    legSwing: Math.sin(t) * 10,
    lean: Math.sin(t) * 0.06,
    blink: false,
  };
}

function drawProceduralFrame(pose: Pose): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = PROCEDURAL_SIZE;
  canvas.height = PROCEDURAL_SIZE;
  const ctx = canvas.getContext("2d")!;

  ctx.translate(PROCEDURAL_SIZE / 2, PROCEDURAL_SIZE / 2);
  ctx.rotate(pose.lean);
  ctx.translate(0, pose.bodyDy);

  const bodyY = 8;
  const rx = 78;
  const ry = rx * pose.squash;

  ctx.fillStyle = "#e8862e";
  const footY = bodyY + ry * 0.86;
  ellipse(ctx, -26 + pose.legSwing, footY, 20, 10);
  ellipse(ctx, 26 - pose.legSwing, footY, 20, 10);

  const body = ctx.createRadialGradient(-24, bodyY - 28, 8, 0, bodyY, rx + 6);
  body.addColorStop(0, "#ffc078");
  body.addColorStop(1, "#f5923e");
  ctx.fillStyle = body;
  ellipse(ctx, 0, bodyY, rx, ry);

  const eyeY = bodyY - 18;
  if (pose.blink) {
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

/** 把 256 的程序帧缩放统一到 FRAME_SIZE，保证两条路径帧尺寸一致 */
function scaleToFrame(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_SIZE;
  canvas.height = FRAME_SIZE;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, (FRAME_SIZE - PROCEDURAL_SIZE) / 2, (FRAME_SIZE - PROCEDURAL_SIZE) / 2);
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
