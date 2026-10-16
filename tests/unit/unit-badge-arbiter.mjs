// 徽标可见性仲裁（ADR-0010 决策 1 / 落地口径第 1 条）的离线单测。
//
// 判据一律是「喂假拍子之后 visible() 是什么」：不睡真实时间、不碰 DOM ——
// `verify:astock` 那条「条数会随盘面形态漂」的教训同源，轮播决不许靠 sleep 5 秒等出来。
// 候选序只认注入的启用清单数组（对应 plugin_enabled_list 的数组序），
// 不认登记先后（登记受加载竞态影响，顺序不稳定）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BADGE_ROTATE_INTERVAL_MS, createBadgeArbiter } from "../../src/runtime/badge-arbiter.ts";

const A = "com.pet.a";
const B = "com.pet.b";
const C = "com.pet.c";
const LIST = [A, B, C];

/** 建仲裁器 + 记下 onChange 的实际值：判据看可见者，不看内部字段 */
function make(enabled = LIST) {
  const arbiter = createBadgeArbiter({ enabled });
  const changes = [];
  const off = arbiter.onChange((v) => changes.push(v));
  return { arbiter, changes, off };
}

/** 登记 + 置为「有内容」（外壳布局尺寸非零） */
function feed(arbiter, ...ids) {
  for (const id of ids) {
    arbiter.register(id);
    arbiter.setHasSize(id, true);
  }
}

describe("候选 = 已登记且尺寸非零，按注入清单序排", () => {
  it("登记了但尺寸为零：tick 不显示它；尺寸到位后才有它", () => {
    const { arbiter } = make();
    arbiter.register(A);
    arbiter.tick();
    assert.equal(arbiter.visible(), null, "零尺寸的格子被当成了有内容");
    arbiter.setHasSize(A, true);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
  });

  it("只报尺寸、没登记的 id 不进候选", () => {
    const { arbiter } = make();
    arbiter.setHasSize(B, true);
    feed(arbiter, A);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.tick();
    assert.equal(arbiter.visible(), A, "单候选时轮次原地不动");
  });

  it("尺寸账只认已登记的 id：登记之前报的尺寸不算数，登记后须重报", () => {
    const { arbiter } = make();
    arbiter.setHasSize(B, true);
    arbiter.register(B);
    arbiter.tick();
    assert.equal(arbiter.visible(), null, "登记前报的尺寸被记进了候选账");
    arbiter.setHasSize(B, true);
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
  });

  it("不在注入清单里的 id 不进候选（刚停用还没摘干净的名字不许冒出来）", () => {
    const { arbiter } = make();
    feed(arbiter, A);
    feed(arbiter, "zz.out-of-list");
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
  });

  it("清单里有重复项：候选按出现序去重，不出现两次", () => {
    const { arbiter } = make([A, A, B]);
    feed(arbiter, A, B);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
  });
});

describe("① 三个有内容者按清单序轮播（喂假拍子）", () => {
  it("第一拍之前不预选：三次 tick 依次可见 A → B → C", () => {
    const { arbiter, changes } = make();
    feed(arbiter, ...LIST);
    assert.equal(arbiter.visible(), null, "还没到拍子就先选了一个");
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
    assert.deepEqual(changes, [null, A, B, C], `onChange 序列不对：${changes.join(" → ")}`);
  });
});

describe("② 第 4 次 tick() 绕回第一个", () => {
  it("A→B→C 之后第 4 拍回到 A", () => {
    const { arbiter } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    arbiter.tick();
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
    arbiter.tick();
    assert.equal(arbiter.visible(), A, "第 4 拍没绕回清单第一个");
  });

  it("后到的候选不会顶掉当前可见者（只有 tick 才换人）", () => {
    const { arbiter } = make([A, B]);
    feed(arbiter, A);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    feed(arbiter, B);
    assert.equal(arbiter.visible(), A, "新候选一出现就抢了镜头");
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
  });
});

describe("③ 中间那个 setHasSize(false) 后被跳过", () => {
  it("A 可见时 B 归零：下一拍直接到 C", () => {
    const { arbiter, changes } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.setHasSize(B, false);
    arbiter.tick();
    assert.equal(arbiter.visible(), C, "B 归零后仍被轮到了（或整轮从头上重来）");
    assert.equal(changes.includes(B), false, "B 在归零之后上过镜");
  });

  it("当前可见者自己归零：立即不再可见，下一拍从它之后续上", () => {
    const { arbiter } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
    arbiter.setHasSize(B, false);
    assert.equal(arbiter.visible(), null, "归零的可见者还被报为可见");
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
  });

  it("归零的格子回来：按清单序重新参与（不跳到队首也不消失）", () => {
    const { arbiter } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.setHasSize(B, false);
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
    arbiter.setHasSize(B, true);
    arbiter.tick();
    assert.equal(arbiter.visible(), A, "B 回队后顺序乱了");
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
  });
});

describe("④ 全部零尺寸 → visible() 为 null（宿主据此隐藏整区）", () => {
  it("候选清空立刻可见者为 null，之后 tick 也保持 null", () => {
    const { arbiter, changes } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    for (const id of LIST) arbiter.setHasSize(id, false);
    assert.equal(arbiter.visible(), null);
    arbiter.tick();
    assert.equal(arbiter.visible(), null, "空候选时 tick 不该凭空造出一个可见者");
    assert.equal(changes.at(-1), null);
  });

  it("全空之后又有内容：下一拍从清单第一个重新开始", () => {
    const { arbiter } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
    for (const id of LIST) arbiter.setHasSize(id, false);
    assert.equal(arbiter.visible(), null);
    arbiter.setHasSize(C, true);
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
  });
});

describe("⑤⑥ setSuppressed(true) 期间 tick() 不推进，恢复后继续", () => {
  it("⑤ 抑制期间连喂三拍，可见者与 onChange 都不动", () => {
    const { arbiter, changes } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    const before = changes.length;
    arbiter.setSuppressed(true);
    arbiter.tick();
    arbiter.tick();
    arbiter.tick();
    assert.equal(arbiter.visible(), A, "全屏期间轮播还在走");
    assert.equal(changes.length, before, "被压住的拍子不该报可见性变化");
  });

  it("⑥ 恢复后从暂停的那一格继续（不是从头重来）", () => {
    const { arbiter } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    arbiter.setSuppressed(true);
    arbiter.tick();
    arbiter.tick();
    arbiter.setSuppressed(false);
    arbiter.tick();
    assert.equal(arbiter.visible(), B, "恢复后没接上原来的位置");
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
  });
});

describe("⑦ unregister 后不再出现在候选里", () => {
  it("摘掉非当前可见者：后续 tick 跳过它，onChange 里不再出现它的名字", () => {
    const { arbiter, changes } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.unregister(B);
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    assert.equal(changes.includes(B), false, "被摘掉的插件上过镜");
  });

  it("摘掉当前可见者：立即不可见，下一拍续到它之后", () => {
    const { arbiter } = make();
    feed(arbiter, ...LIST);
    arbiter.tick();
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
    arbiter.unregister(B);
    assert.equal(arbiter.visible(), null);
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
  });

  it("摘掉再登记回同一个 id：尺寸从零重来，报到有内容才重新参与", () => {
    const { arbiter } = make();
    feed(arbiter, A);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    arbiter.unregister(A);
    assert.equal(arbiter.visible(), null);
    arbiter.register(A);
    arbiter.tick();
    assert.equal(arbiter.visible(), null, "重登记带回了上一次的尺寸账");
    arbiter.setHasSize(A, true);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
  });
});

describe("⑧ 乱序登记但按注入清单顺序轮播", () => {
  it("按 C→B→A 登记，三拍仍是 A→B→C", () => {
    const { arbiter } = make();
    feed(arbiter, C);
    feed(arbiter, B);
    feed(arbiter, A);
    arbiter.tick();
    assert.equal(arbiter.visible(), A, "第一拍跟着登记顺序走了");
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
    arbiter.tick();
    assert.equal(arbiter.visible(), C);
  });

  it("注入清单用函数时每次重算现取（启停序变了不用重建仲裁器）", () => {
    let order = [A, B];
    const arbiter = createBadgeArbiter({ enabled: () => order });
    feed(arbiter, A, B);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    // 宿主把 B 提到 A 前面（plugin_enabled_list 的新数组序）
    order = [B, A];
    const seen = [];
    arbiter.onChange((v) => seen.push(v));
    // 当前可见者 A 仍是候选 → 不变化；tick 之后按新序走 A 的下一个 = B（两候选里等价）
    arbiter.tick();
    assert.equal(arbiter.visible(), B);
    arbiter.tick();
    assert.equal(arbiter.visible(), A);
    assert.deepEqual(seen, [B, A]);
  });
});

describe("⑨ 轮播间隔是具名常量、纯模块不许吃真实时间", () => {
  it("BADGE_ROTATE_INTERVAL_MS 就是 5000", () => {
    assert.equal(BADGE_ROTATE_INTERVAL_MS, 5000);
  });

  it("模块源码里没有计时器 / 真实时间 / DOM / 存储（计时器只在 widget-host 侧）", () => {
    const src = readFileSync(new URL("../../src/runtime/badge-arbiter.ts", import.meta.url), "utf8");
    // 去掉注释再扫，避免注释里提到这些词就误报
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["setInterval", "setTimeout", "Date.now", "performance.now", "document.", "localStorage"]) {
      assert.equal(code.includes(bad), false, `badge-arbiter.ts 里出现了 ${bad}`);
    }
  });
});

describe("onChange 的订阅契约", () => {
  it("同一个可见者不重复通知；退订后不再回调", () => {
    const { arbiter, changes, off } = make();
    feed(arbiter, A);
    arbiter.tick();
    arbiter.tick();
    arbiter.tick();
    assert.deepEqual(changes, [null, A], `重复通知了：${changes.join(" → ")}`);
    off();
    arbiter.unregister(A);
    assert.equal(changes.length, 2, "退订后还收到了回调");
  });

  it("注册的当下就会收到一次初始状态（宿主据此先把整区收好）", () => {
    const arbiter = createBadgeArbiter({ enabled: LIST });
    const changes = [];
    arbiter.onChange((v) => changes.push(v));
    arbiter.register(A);
    assert.deepEqual(changes, [null], "注册时没拿到初始状态，宿主会漏掉一次布局收敛");
  });
});
