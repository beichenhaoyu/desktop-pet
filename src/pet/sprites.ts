// 程序生成的占位序列帧：正式版由美术提供 PNG 序列帧后，只需替换本文件，
// 播放器与状态机接口不变。

export type ActionName = "idle" | "walk" | "sleep" | "react";

/** 各动作的序列帧集合；sleep/react 的帧在后续实施步骤补充 */
export type SpriteSet = Partial<Record<ActionName, HTMLCanvasElement[]>>;

export const FRAME_SIZE = 256;
const FRAME_COUNT = 8;

// 每帧的姿态参数，由动作生成函数按相位计算
interface Pose {
  bodyDy: number; // 身体纵向位移（呼吸 / 弹跳）
  squash: number; // 身体纵向缩放（1 为正常）
  legSwing: number; // 脚步前后摆动
  lean: number; // 身体倾斜（弧度）
  blink: boolean;
}

export function buildSpriteSet(): SpriteSet {
  return {
    idle: Array.from({ length: FRAME_COUNT }, (_, i) => drawFrame(idlePose(i))),
    walk: Array.from({ length: FRAME_COUNT }, (_, i) => drawFrame(walkPose(i))),
  };
}

function idlePose(i: number): Pose {
  const t = (i / FRAME_COUNT) * Math.PI * 2;
  return {
    bodyDy: Math.sin(t) * 2,
    squash: 1 + Math.sin(t) * 0.02,
    legSwing: 0,
    lean: 0,
    blink: i === 5,
  };
}

function walkPose(i: number): Pose {
  const t = (i / FRAME_COUNT) * Math.PI * 2;
  return {
    bodyDy: -Math.abs(Math.sin(t)) * 5,
    squash: 1,
    legSwing: Math.sin(t) * 10,
    lean: Math.sin(t) * 0.06,
    blink: false,
  };
}

function drawFrame(pose: Pose): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_SIZE;
  canvas.height = FRAME_SIZE;
  const ctx = canvas.getContext("2d")!;

  ctx.translate(FRAME_SIZE / 2, FRAME_SIZE / 2);
  ctx.rotate(pose.lean);
  ctx.translate(0, pose.bodyDy);

  const bodyY = 8;
  const rx = 78;
  const ry = rx * pose.squash;

  // 脚（画在身体下层，走路时前后交替）
  ctx.fillStyle = "#e8862e";
  const footY = bodyY + ry * 0.86;
  ellipse(ctx, -26 + pose.legSwing, footY, 20, 10);
  ellipse(ctx, 26 - pose.legSwing, footY, 20, 10);

  // 身体
  const body = ctx.createRadialGradient(-24, bodyY - 28, 8, 0, bodyY, rx + 6);
  body.addColorStop(0, "#ffc078");
  body.addColorStop(1, "#f5923e");
  ctx.fillStyle = body;
  ellipse(ctx, 0, bodyY, rx, ry);

  // 眼睛
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

  // 腮红
  ctx.fillStyle = "rgba(255, 120, 90, 0.45)";
  ellipse(ctx, -46, bodyY + 6, 10, 6);
  ellipse(ctx, 46, bodyY + 6, 10, 6);

  // 嘴巴（微笑弧线）
  ctx.strokeStyle = "#5b3a12";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, bodyY + 8, 18, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

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
