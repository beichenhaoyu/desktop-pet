// 极简 PNG 解码（零依赖，inflate 走 node:zlib）。
// 存在的理由：widget 走 Worker 路线后，画布控制权已经交给 Worker，主线程 `getContext` 必抛
// （T18 的结论，在产品路径上被 verify:astock 复现）—— 想继续数「图真的画出来了」的墨迹像素，
// 就只能看合成后的画面：CDP 截图 → 这里解码 → 数像素。
// 只支持截图会用到的形态：8 bit、非隔行、colorType 0/2/4/6。其余直接抛，不做静默降级。
import { inflateSync } from "node:zlib";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** base64（不带 data: 前缀）→ { width, height, rgba } */
export function decodePng(base64) {
  const buf = Buffer.from(base64, "base64");
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error("不是 PNG 数据");
  }
  let pos = 8;
  let ihdr = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        color: body[9],
        interlace: body[12],
      };
    } else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error("PNG 缺 IHDR");
  if (ihdr.depth !== 8) throw new Error(`只支持 8 bit，实得 ${ihdr.depth}`);
  if (ihdr.interlace !== 0) throw new Error("不支持隔行 PNG");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error(`不支持的 colorType ${ihdr.color}`);
  const { width, height } = ihdr;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("IDAT 长度不对，解不出来");

  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      cur[x] =
        filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : filter === 4
                  ? v + paeth(a, b, c)
                  : (() => {
                      throw new Error(`未知 PNG filter ${filter}`);
                    })();
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      if (channels === 1) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[s];
        rgba[o + 3] = 255;
      } else if (channels === 2) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[s];
        rgba[o + 3] = cur[s + 1];
      } else if (channels === 3) {
        rgba[o] = cur[s];
        rgba[o + 1] = cur[s + 1];
        rgba[o + 2] = cur[s + 2];
        rgba[o + 3] = 255;
      } else {
        rgba[o] = cur[s];
        rgba[o + 1] = cur[s + 1];
        rgba[o + 2] = cur[s + 2];
        rgba[o + 3] = cur[s + 3];
      }
      o += 4;
    }
    prev = cur;
  }
  return { width, height, rgba };
}

/** 与背景色差超过 tol 的像素数（沿用 verify-astock 原来那套阈值口径） */
export function inkCount({ rgba, width, height }, bg = [17, 19, 26], tol = 12) {
  let ink = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (
      Math.abs(rgba[o] - bg[0]) > tol ||
      Math.abs(rgba[o + 1] - bg[1]) > tol ||
      Math.abs(rgba[o + 2] - bg[2]) > tol
    )
      ink++;
  }
  return ink;
}
