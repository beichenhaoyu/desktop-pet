# T16 gaps —— 22 个方法表覆盖不到的需求

> **这份为什么在库里**：它是 ADR-0008 的取证输入（那条 ADR 的八条决策逐条对得上本文的编号），
> 原来只躺在派单工作区 `.dispatch/arch-p2/reference/`（工作区，不入库），读者与外部助手都打不开。
> R4 的处置是：**被入库文档当依据引用的取证件收进库，过程稿（台账、卡片、原始扫描）留在工作区**。
> 本文按 T16 回传时的原样收录，不改写 —— 里面标着「PM 决策」的那几项后来由 ADR-0008 定案
> （画布走 (b) `transferControlToOffscreen` 交接、不开 `html` 指令），把后见之明写回快照会毁掉它的取证价值。
> 统计口径里的 `realm-deps.tsv` 是 434 行原始扫描，属过程稿，不入库；结论以本文为准。

统计口径：`realm-deps.tsv` 的 434 行里 A=96、B=0、C=0、D=338。**B 与 C 全为零**，
所以四个插件的入口闭包（11 个 entry + 9 个 both 文件）对宿主 realm **没有任何依赖**，
也没有裸 IPC 或跨 realm 传函数的形状问题。全部 338 行 DOM 依赖都落在 **widget 图（16 个 widget-only 文件）** 里。
下面每条给：涉及行数、涉及文件数、代表坐标、L2 要承接它需要的新契约名、风险判定。

## 1. 渲染指令（`render-cmd:*`，338 行 / 16 个文件）

按桶归并，一个桶一个指令名候选：

| 桶（候选指令名） | 行数 | 代表坐标 | 现在这段在做什么 | 风险 |
|---|---|---|---|---|
| `el-append` | 96 | `com.pet.hr-ble/widget.js`、`com.pet.astock/views/settings/board.js` | `container.append(el, ...)` 把新建节点插入 Shadow Root | 中：形状规则，是量的大头 |
| `el-text` | 76 | `com.pet.agent-bridge/widget.js`、`com.pet.todo/widget.js` | `node.textContent = 值` 的数据回写 | 低：一条 `text` 指令即可 |
| `dom-query` | 57 | `com.pet.astock/views/settings/prefs.js`、`com.pet.hr-ble/widget.js` | `document.` / `querySelector` 取自己的节点 | 中：Worker 里不该再有查询语义，指令要按宿主发的节点句柄寻址 |
| `el-create` | 46 | 四个插件的 `widget.js` 都有 | `document.createElement("div" / "button" / "canvas" / …)` | 中：需要节点类型白名单 |
| `el-on` | 17 | `com.pet.agent-bridge/widget.js:155`、`:257` | 给节点挂 `change` / `click` 监听并把值回传 | **高**：这是**反向通道**，22 表里没有对应物，必须新建「事件回流」形状 |
| `el-style` | 14 | `com.pet.astock/views/settings/*.js` | `el.style.width = "…" ` 逐属性写样式 | 中：样式对象批量下发比逐属性省消息数 |
| `el-dataset` | 11 | `com.pet.astock/views/settings/watch-list.js` | `el.dataset.k = v` 把 id 挂在节点上供点击回捞 | 中：与 `el-on` 是一对（点了要能认出是谁） |
| `el-ns` | 6 | `com.pet.hr-ble/widget.js:118-130` | `document.createElementNS("http://www.w3.org/2000/svg", …)` 建 SVG 心形与渐变 | **高**：SVG 命名空间 + defs/stop 嵌套，指令形状最复杂 |
| `host-event` | 4 | `com.pet.astock/views/settings.js:85-86`、`views/settings/board.js:64` | `window.addEventListener("resize", …)` 与按 `window.devicePixelRatio` 重画 | **高**：Worker 里没有 `window`，尺寸/重绘时机只能由宿主推送 |
| `el-class` | 5 | `com.pet.todo/widget.js`、`com.pet.astock/views/badge.js` | `classList.toggle / add / remove` 换状态类名 | 低 |
| `host-dpr` | 2 | `com.pet.astock/views/settings/board.js:64,66` | 把 `window.devicePixelRatio` 传给画图函数 | 中：dpr 必须由宿主随帧/随尺寸变化下发 |
| `canvas-2d` | 2 | `com.pet.astock/charts.js:39`、`com.pet.hr-ble/widget.js:167` | `canvas.getContext("2d")` 后逐帧画折线/心率波形 | **高**：见下面第 2 节 |
| `el-html` | 1 | `com.pet.hr-ble/widget.js:293` | `panel.innerHTML = \`…\`` 一段模板字符串 | **高**：等于从 Worker 发 HTML 字符串，与既有「插件不得直接操作 DOM」的边界冲突，见第 3 节 |
| `dom-measure` | 1 | `com.pet.astock/views/settings/board.js:61` | `canvas.clientWidth` 量自身尺寸 | 中：测量只能宿主做，量完随 resize 事件下发 |

**结论：渲染指令契约的最小词汇 = 上面 14 个桶**，其中四个（`el-on` / `host-event` / `el-ns` / `canvas-2d` / `el-html`）不是「把 DOM 调用换个名字发出去」就能承接的，需要独立设计。

## 2. 画布（`canvas-2d`，2 行）

- `plugins/com.pet.astock/charts.js:39` 与 `plugins/com.pet.hr-ble/widget.js:167` 都要 `getContext("2d")` 逐帧画。
- L1 实测过 Worker 里有 `OffscreenCanvas`（ADR-0006 第 5 条），但**画布所有权的交接只能在主文档发起**（`transferControlToOffscreen`）。
- 缺口：现在这条通道的形状没定。两种形状二选一，PM 决策：
  - (a) 画布留在宿主 realm 的 widget 容器里，Worker 只发「画这批点」的**数据指令**，宿主自己取 2d context 画 —— 改动最小，但把绘图逻辑留在宿主侧，`charts.js` 要一分为二；
  - (b) 宿主建 canvas 后 `transferControlToOffscreen` 交给 Worker，Worker 用 `OffscreenCanvasRenderingContext2D` 画 —— 真隔离彻底，但 astock 的图表代码要按 OffscreenCanvas 的 API 子集重写，且 dpr/尺寸变更要额外协议。

## 3. HTML 字符串（`el-html`，1 行）

- `plugins/com.pet.hr-ble/widget.js:293` 用模板字符串写整段面板 HTML。
- Worker 版如果允许 `html` 指令，等于把「插件代码可以注入任意标记」这条既有边界重新打开（AGENTS.md：插件不得直接操作 DOM，widget 只能在各自 Shadow DOM 内）。
- 缺口：要么把它改写成一串结构化指令（推荐，只有 1 处），要么给 `html` 指令定净化口径 —— PM 决策。

## 4. 反向事件通道（`el-on` + `host-event` + `el-dataset`，32 行）

- 现状：widget 在宿主 realm 里直接 `addEventListener`，回调就在同一个 realm，闭包能捕获任何东西。
- Worker 版必须是「宿主监听 → 按节点句柄 + 事件名 → postMessage 回 Worker」，并且 Worker 侧要能把回调函数与节点对上。
- 这条通道的形状（句柄怎么发、事件怎么标、能不能取消）在 22 表里完全没有对应物，**是 L2 必须先定契约、再迁移的第一优先项**。

## 5. 表外命令面（本卡顺带核到，但不属 realm 问题）

- `plugins/com.pet.astock/main.js` 与 `views/settings/add.js` 里用到的 `ctx.*` 全在 22 表内；
  四个插件的入口闭包用到的 ctx 成员只有 `storage.*`、`bus.publish`、`bus.subscribe`、`widget.update`、`notify.show`、`pet.react`、`pet.say`、`http.request`、`overlay.*`、`log` —— **`ble.*` 与 `agentHooks.*` 只在 hr-ble 与 agent-bridge 的入口/设置区出现**，原型里已覆盖，不需要新增表项。
- 也就是说：**阶段一（入口搬进 Worker）不需要动 22 表**，缺的都在阶段二（widget）。
