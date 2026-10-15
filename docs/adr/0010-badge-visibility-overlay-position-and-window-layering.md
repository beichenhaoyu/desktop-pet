# ADR-0010：徽标只仲裁可见性，overlay 归插件自定位，本体窗永远压住 overlay

- **状态**：已接受（2026-10-16，用户定口径；本文同时记下取证现场）
- **相关**：[ADR-0002](0002-single-agent-linkage-uninstall-then-install.md)（单联动，与「谁占 overlay」同族问题，本 ADR 决定**不**做仲裁）、
  [ADR-0003](0003-session-visibility-on-pet-bubble.md)（气泡几何：头顶区从此归它独占）、
  [ADR-0005](0005-command-layering-thin-command-bodies.md)（`overlay_*` 命令的分层与形状门禁）、
  [ADR-0008](0008-widget-host-in-web-worker-render-commands.md)（widget 的 realm 与渲染契约）、
  [docs/plugin-dev/PLUGIN_SDK.md](../plugin-dev/PLUGIN_SDK.md) §4 能力表与 §5.1 渲染契约

## 背景

L2 把 widget 搬进 Worker 之后，「UI 面归谁」这件事只剩一半答案：**渲染方式**归契约，**摆放与堆叠**仍是插件各自决定。
用户据此提了两条需求：徽标只允许存在一个、内容由插件推送且多内容轮播；overlay 只允许两个位置、由宿主提供、
插件必须自设开关且默认关闭、宿主只接受第一个打开的请求。

定口径前先量了三件事，两条需求都被实测改写过：

1. **z 序**：宠物窗与 overlay 都是 `alwaysOnTop(true)`（[tauri.conf.json](../../src-tauri/tauri.conf.json) 的 `pet` 窗、
   [src-tauri/src/window/overlay.rs](../../src-tauri/src/window/overlay.rs) 的建窗），同层内谁最后被置顶/创建谁在上。
   真窗枚举实测（`tools/win-zorder.ps1`，三次采样一致）：**overlay 压在宠物之上**，
   且设置窗 `"DesktopPet 设置"` 连 topmost 都不是（`plain`）。⇒「宿主永远在上层」今天**不成立**。
2. **头顶 overlay 有人在用**：agent 桥（`above-pet`, h=104）与待办（`above-pet`, h=176），盯盘用 `corner`。
   而 [ADR-0003](0003-session-visibility-on-pet-bubble.md) 已经把气泡区的垂直预算算死（窗 360×360、
   立绘顶边 y=47、气泡底边 y=55、3 行就被裁）。两张头顶卡 + B3 的常驻状态行抢的是同一条带。
3. **启停清单是有序的**：`plugin_enabled_list` 返回 `Vec<String>`，`sanitize` 用 `HashSet` 去重但**保留数组序**
   （[src-tauri/src/services/enabled.rs](../../src-tauri/src/services/enabled.rs)），并有 `host:enabled-changed` 广播 ⇒
   「按启用清单顺序轮播」是确定可复现的判据，不是碰运气。

## 决策

1. **徽标（badge）：宿主只做可见性仲裁，不接管内容。**
   `#widget-badge` 里每插件一个插槽照旧（插件仍照 ADR-0008 的契约自己画），**新增的只是「同时只有一个插槽可见」**：
   - 轮播每格停留 **5 秒**，顺序 = `plugin_enabled_list` 的数组序；
   - **没有任何徽标有内容时整个徽标区隐藏**（不是显示空白格子）；
   - 收到 `host:fullscreen` 且 `active` 为真时**暂停轮播**（`host:fullscreen` 已在广播，目前只有
     [src/pet/game-mode.ts](../../src/pet/game-mode.ts) 一个消费者，这里加第二个）；
   - 不可见期间**不做任何特殊处理**：不通知插件、不暂停插件的 Worker、不折叠内容 —— 用户明确判断这点性能占用不影响。
   - 「一个插件设了多个徽标内容」是**插件在自己的 badge widget 内轮**；宿主只轮「哪个插件可见」。两层分工不合并。
   被否的另一面：**内容通道**（插件调 `ctx.badge.push(items)`、宿主渲染）。它能让断言面只有一个节点，
   但要把 `WidgetRegion` 从三值缩成两值、四个插件的 badge 代码删掉、SDK 与 §5.1 与 `unit:migrate` 的 REGIONS 全改，
   而且等于**推翻刚落地还没对外验证的 L2 契约**。可见性仲裁在插件侧零改动就能满足需求，故选它。
2. **overlay：保持「每插件最多一扇」，不引入租约与共享窗。**
   用户改口后这条大幅缩水：宿主**不**仲裁、**不**限制数量、**不**提供位置。今天就是每插件一扇
   （label `overlay-<插件 id>`），保持不变。
3. **删掉「宠物头顶」这一档 placement，且不再保留。**
   `PLACEMENT_ABOVE_PET`、`resolve_placement` 的对应分支、以及 `start_follow_timer` 里贴头顶跟随的那段一并去掉
   （顺带少一个常驻轮询）。**头顶那条带从此归 [ADR-0003](0003-session-visibility-on-pet-bubble.md) 的气泡分层独占**，
   B3 不用再跟悬浮卡抢同一块屏幕。
4. **位置由插件直传，宿主不干涉、不持久化、不支持拖拽。**
   契约改成 `overlay.show({ x, y, height })`；坐标由插件自己存进 `ctx.storage`（宿主不记，避免多出一个宿主态与
   一份「谁改了位置」的口径）；宿主只保留**屏内夹紧**这一件事（与既有 `clamp_height` 同族），
   防止插件把卡片存到屏幕外变成"打不开"的隐形 bug。锚点预设、拖拽取位、设置界面里的位置项全部不做。
5. **本体窗永远压在所有 overlay 之上，这是一条对外承诺，判据用真窗次序。**
   验收只认 `tools/win-zorder.ps1`：轮询到宠物窗与 overlay 同框时，宠物必须排在更前（脚本 exit 0），
   否则 exit 1。**不接受"读代码看谁设了 alwaysOnTop"式的论证**——本 ADR 的背景 1 就是被这条推翻的。
   实现路线三条，按代价从低到高，落地时先试再定并记回本文：
   (a) 每次 overlay 创建/显示后重新对宠物窗 `set_always_on_top(true)` 触发 topmost 层内重排（零新依赖，可能抢焦点）；
   (b) 用 `windows` crate（**已在依赖里**，0.62）走 `SetWindowPos(HWND_TOPMOST, insertAfter = 宠物 HWND)` 做层内相对次序，
   需在每扇 overlay 的生命周期里重放；
   (c) overlay 不置顶（语义最省，但会被第三方程序盖住，多半不是要的观感）。
6. **两个插件的去向**：agent 桥的头顶会话卡**并入 B3**（它本来就是"节点状态"的另一种表达，
   而 A9b 已打算去掉会话状态卡）；待办的桌面卡片**走插件自定坐标**。

## 后果

- **对外契约变更两处**：`overlay.show` 的入参形状（`placement` → `x, y, height`）与「本体压住 overlay」这条保证。
  SDK 类型面、PLUGIN_SDK §5.1/HANDBOOK 的对应口径都要跟着改；这属于第三方接入前必须做完的事。
- **测试面**：`verify:todo` / `verify:agent` / `verify:astock` 里断言悬浮卡位置与收起的条目要按新参数重写；
  `verify-isolation` 的 overlay 门禁组（含 `placement` 的取值断言与 label 编码断言）同步；
  `check:shape` 的 48 条命令计数不变（改参数不减命令）。
  徽标轮播要新增**离线可注入 tick** 的单测（三格内容 → 第 N 拍谁可见、无内容隐藏、`host:fullscreen` 暂停），
  **不许用真实时间断言**——`verify:astock` 那条「条数随盘面形态漂」的教训同源。
- **z-order 断言只能跑 Windows**：`tools/win-zorder.ps1` 属运行时取证工具，不进 CI 的必须绿门；
  若要进 e2e 手动门，得保证那一刻真有 overlay 在场（脚本没有同框样本时退 2，与「判据没成立」区分开）。
- **Win32 互操作的两个坑**记在 `tools/win-zorder.ps1` 头部：`DllImport` 默认 `CharSet.Ansi` 配 `*W` 函数会让
  标题只剩第一个字符（现象是"枚举不到窗口"）；交给 `EnumWindows` 的委托没有静态根会被 GC 掉，
  表现为"返回 true 却一次都不回调"。
- **B3 的范围要重划**：并入 agent 桥的节点状态之后，常驻行/台词分层与"来自 agent 的状态"是同一条带上的同一件事。
- 性能上明确接受：**四个 badge Worker 常驻**，只是同时显示一个；宿主不告知插件它当前不可见。
