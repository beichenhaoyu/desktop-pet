// 相对子模块：入口在 Worker 里的 `./leaf.js` 能不能解析，就靠这个常量证实或证伪。
// verify-worker.mjs 会在装上之后把它改成 leaf-v2，用来量「同一个 Worker 里模块映射表的陈旧」
// 与「换一个 Worker 之后取到新内容」这两件事。
export const LEAF_MARKER = "leaf-v1";
