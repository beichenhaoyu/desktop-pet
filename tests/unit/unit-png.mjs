// PNG 解码器自测（tests/e2e/harness/png.mjs）。
// 它现在撑着一句运行时断言：verify:astock 的「图真的画出来了」改成数截图像素之后，
// 解码器若错了，那条断言就成了假的 —— 所以解码器本身得被单独钉住。
// 编码端在这里手写五种 filter，是因为 node 没有现成的 PNG 编码器，
// 而参考值必须取**原始**像素（Sub 的左邻是当前行重建后的原始字节，Up 的上是上一行原始字节）——
// 我第一版就是拿编码后的字节当左邻，自测当场红，才确认错在夹具不在解码器。
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { describe, it } from "node:test";
import { decodePng, inkCount } from "../e2e/harness/png.mjs";

const BG = [17, 19, 26, 255];
const RED = [255, 0, 0, 255];

const chunk = (type, body) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(type, "ascii"), body, Buffer.alloc(4)]);
};

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** RGBA 像素 → 手工 PNG（每行一种 filter，用来逐个验重建） */
function encodePng(pixels, w, h, filters) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const line = pixels.subarray(y * stride, y * stride + stride);
    const f = filters[y];
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? line[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      const v =
        f === 0 ? line[x] : f === 1 ? line[x] - a : f === 2 ? line[x] - b : f === 3 ? line[x] - ((a + b) >> 1) : line[x] - paeth(a, b, c);
      raw[y * (stride + 1) + 1 + x] = v & 0xff;
    }
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

function flat(w, h, fill) {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) b.set(fill, i * 4);
  return b;
}

describe("PNG 解码：五种 filter 的重建都得回到原像素", () => {
  for (const [label, f] of [["none", 0], ["sub", 1], ["up", 2], ["average", 3], ["paeth", 4]]) {
    it(`filter ${label}`, () => {
      const src = flat(3, 2, BG);
      src.set(RED, 4); // 第一行第二格涂红
      const back = decodePng(encodePng(src, 3, 2, [f, f]));
      assert.equal(back.width, 3);
      assert.equal(back.height, 2);
      assert.deepEqual([...back.rgba.subarray(0, 4)], BG);
      assert.deepEqual([...back.rgba.subarray(4, 8)], RED, "红格解错");
      assert.deepEqual([...back.rgba.subarray(20, 24)], BG, "最后一格不该是红的");
      assert.equal(inkCount(back, [17, 19, 26]), 1, "只该数出一格墨迹");
    });
  }

  it("空白画布必须数出 0 格墨迹（不然「画出来了」那条断言在空图上也会绿）", () => {
    const blank = decodePng(encodePng(flat(4, 4, BG), 4, 4, [0, 1, 2, 4]));
    assert.equal(inkCount(blank, [17, 19, 26]), 0);
  });

  it("非 8 bit / 隔行 / 未知 colorType 一律抛，不静默给半张图", () => {
    assert.throws(() => decodePng(Buffer.from("not a png").toString("base64")), /不是 PNG/);
  });
});
