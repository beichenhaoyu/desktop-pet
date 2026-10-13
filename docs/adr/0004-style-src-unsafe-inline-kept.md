# 插件运行时保留 `style-src 'unsafe-inline'`，样式注入契约不撤销

打包版 CSP（`src-tauri/tauri.conf.json` 的 `csp` 键）里 `style-src` 目前是 `'self' 'unsafe-inline'`。
清单第 34 项要求「评估收紧」。**决定：本波不收紧**，并把「插件可以往自己的 Shadow Root 里注入样式表」
明确保留为对外契约；同时把另一类（markup 里的内联 `style=` 属性）清零 —— 那部分已由 M2a 落地，
不依赖本决定，也不需要它。

**为什么算决策**：这不是"还没做完"，而是一次有代价的取舍 —— 收紧的唯一收益是把 CSP 表面做完整，
成本却落在第三方插件作者的写法约定上，而我们已经承认进程内 JS 插件不是硬安全边界
（AGENTS.md「安全边界共识」）。写下来免得下一波人又从清单里重新发明这件事。

## 收紧要动的东西（2026-10-13 现场逐条取证，行号是当日读数）

判定依据分两条：`style-src` 管 **style 元素**与 **markup 的 `style=` 属性**两类；
CSSOM 的逐属性赋值（`el.style.x = …`、`setProperty`）不在它的检查入口里。

| # | 落点 | 形态 | 去掉 `'unsafe-inline'` 后 |
|---|---|---|---|
| 1 | 原 `src/index.html` 的 `#err-overlay` 内联属性 | markup 属性 | **已由 M2a 消除**，现由外部样式表 `/boot-error.css` 承载 |
| 2 | `plugins/com.pet.agent-bridge/widget.js:44` | style 元素 → ShadowRoot | 会拦 |
| 3 | 同上 `:67`（overlay 大卡） | style 元素 | 会拦 |
| 4 | 同上 `:117`（设置页面板） | style 元素 | 会拦 |
| 5 | 同上 `:178`（hook 面板） | style 元素 | 会拦 |
| 6 | `plugins/com.pet.astock/views/dom.js:5`（`badge.js` / `overlay.js` / `views/settings*` 共用） | style 元素 | 会拦，一处拦三个视图 |
| 7 | `plugins/com.pet.hr-ble/widget.js:30` | style 元素 | 会拦 |
| 8 | 同上 `:72`（波形卡） | style 元素 | 会拦 |
| 9 | 同上 `:272`（设置页面板） | style 元素 | 会拦 |

另有宿主与插件共 17 处 `.style.xxx =` 与 5 处 `setProperty`，这些**不受影响**，收紧时不用动。

## 为什么现在不做

1. **它是已发布的对外契约，不是内部实现细节**。三个示例插件都用同一个形状写样式，而
   `tests/e2e/verify-release.mjs:103` 那条断言（标题「widget 注入 <style> 被 style-src 放行」）
   是在**替第三方把这个契约钉住**。撤销它等于对插件作者改口，成本不由我们单方承担。
2. **替代路径每一条都还没被真机证明**。可想到的三条：外部样式表（给 ShadowRoot 挂 link，要 `style-src`
   放行 `http://petplugin.localhost`）、构造式样式表（`new CSSStyleSheet()` + `adoptedStyleSheets`，
   规范把这类"用 JS 塞 CSS 字符串"归到 `unsafe-eval` 名下，边界要实测）、Tauri 的 nonce/hash 注入
   （官方文档说的是编译期给 bundled assets 加，运行时造的 style 元素拿不到 nonce）。
   在 WebView2 上逐条验证需要一次真实打包构建 + 探针插件，本波没有这个预算。
3. **实际防护增量接近零**。能注入样式的代码本来就能在同一 realm 里做等价的事（改 DOM、调 `element.style`、
   甚至 `import { invoke }` 绕过桥 —— 后者 AGENTS.md 已明说拦不住，要等 Web Worker 宿主）。
   真正要收的是**脚本**那一侧：`script-src` 里没有 `unsafe-inline`，且 `verify-release.mjs:53` 有断言钉着。

## 后果

- `style-src` 保持 `'self' 'unsafe-inline'`；**markup 内联样式已经清零**，所以属性这一类今后再出现就是回归，
  由 `verify-isolation` 的外链样式断言与 `tools/check-docs`（R7）一起拦。
- 要收紧时的正确顺序：先做 Web Worker 宿主（清单 L1/L2）→ 宿主与插件统一改用构造式样式表 →
  真机验证 U 组事项 → 再把 `verify-release.mjs:103` 那条断言**反过来**（判 style 元素被拦）并删掉 `'unsafe-inline'`。
  顺序反了就会出现"插件全裸样式"的发布事故。
- 本决定不影响 M2 的交付口径：清单第 34 项要的是「结论写入 ADR」，结论就是这份，而不是"已收紧"。

## 待验清单（真要收紧前必须逐条有读数）

- U-1 打包版去掉 `'unsafe-inline'` 后，8 处 style 元素是否真的被拦（等价于那条断言是否变红）。
- U-2 Shadow Root 内的 style 元素与文档内的是否同受 `style-src` 约束（本表 #2–#9 的前提）。
- U-3 CSSOM 逐属性赋值在收紧后不受影响的 A/B 复现。
- U-4 Tauri 编译期 nonce/hash 的实际覆盖面（能否给运行时造的元素用）。
- U-5 dev 态确实不下发 CSP（决定"这类问题 dev 测不出来"是否成立）。
- U-6 ShadowRoot 里挂外部样式表 link 能否加载并只作用于该 shadow。
- U-7 启动错误条在样式到达前触发时的可见性（M2a 的 timing 里两条 `[推测]` 就是它）。
