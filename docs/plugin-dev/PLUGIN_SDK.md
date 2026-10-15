# 插件 SDK

面向第三方插件作者。宿主是 Tauri 2 + WebView 的 Windows 桌面宠物，插件是**运行在 WebView 内的 ES Module**。

## 1. 一个插件长什么样

```
plugins/
  com.example.weather/
    manifest.json      # 必需，id 必须等于目录名
    index.js           # manifest.entry，主逻辑，运行在宠物窗上下文
    widget.js          # 可选，manifest.widget，渲染层
    topics.js          # 可选，自己拆的子模块，用相对 import
```

把整个目录放进 `plugins/` 即被扫描到（无需重启宿主），在设置窗打开开关后激活。删除目录会自动停用并卸载 widget。

**目录名必须等于 `manifest.id`。** 不一致的目录会被宿主直接剔除（防止冒用他人身份读写其存储与 widget 路径）。

### manifest.json

| 字段 | 必需 | 规则 |
|---|---|---|
| `id` | 是 | `^[a-z0-9][a-z0-9.-]{2,63}$`，且必须等于目录名 |
| `name` | 是 | 展示名 |
| `version` | 是 | 字符串 |
| `entry` | 是 | `^[\w.-]+\.js$`，不能带路径分隔符 |
| `widget` | 否 | 同上 |
| `permissions` | 否 | 能力名数组，见第 3 节 |
| `apiVersion` | 否 | 整数，缺省 1；宿主认识 `1`、`2`。**带 `widget` 的插件要写 `2`**，表示 widget 照第 5.1 节的渲染契约写 —— 仍是 1 的 widget 不会进 Worker，插槽里显示迁移提示 |
| `minHostVersion` | 否 | 三段以内数字版本，高于当前宿主时拒绝加载 |

## 2. 生命周期

```js
export async function activate(ctx) { /* 宿主在启用时调用一次 */ }
export async function deactivate() { /* 停用/移除时调用 */ }
```

- `activate` 抛错只隔离该插件，宿主把错误广播给设置窗红条，不会崩宿主。
- 插件的 `permissions` 在首次激活时**一次性**弹框请求；用户拒绝则该插件本次不激活。
  授权之后如果 manifest 又新增了还没授权的能力，**那次调用**会再弹一次（桥的逐项校验只在"调用时仍缺"才补请求）。
  所以写回归断言时：断言"弹过同意框"并核对授权记录就好，**别钉死第几次调用才弹** —— 触发时机是宿主的实现细节。
- 同一个插件的 activate / deactivate 由宿主排在**一条串行链**上：弹同意框期间把开关关掉，
  不会出现「在已停用状态下激活」，也不会并发跑两遍 `activate`。
- **停用时宿主替你收尾**：你在 `ctx.bus.subscribe` 上挂出去的订阅会被统一回收，
  widget 会卸载，本插件占着的共享 BLE 资源按持有者释放。你自己的 `setInterval` /
  `setTimeout` 不在回收范围内，仍要在 `deactivate()` 里清掉。
- 覆盖 `index.js` / `widget.js` 后在设置窗里关掉再打开就生效（宿主按文件修改时间给
  模块 URL 加版本串，不会命中旧的模块缓存），不必重启宿主。改 `manifest.json` 里的
  `version` 不是必要条件。
- 用户在设置窗点「撤销授权」后，该插件已缓存的授权会立刻失效：下一次调用任何能力
  会重新弹同意框，同时它的存储目录已被连带清空。

## 2.1 隐身期间

宠物窗可能因「游戏模式」（检测到别的应用全屏）被隐藏。隐藏只影响窗口可见性与本体动画循环，**你的插件会继续运行**：总线、存储、蓝牙、定时器都不停。所以别用 `requestAnimationFrame` 给插件逻辑计时（隐藏时它可能仍在跑，也可能被浏览器节流），用 `setInterval` 或事件驱动。

## 3. 能力清单

未声明的能力调用会被**宿主直接拒绝**（不是弹框），所以 `permissions` 要写全。

| 能力名 | 授予的 API | 说明 | 风险面 |
|---|---|---|---|
| `bus:publish` | `ctx.bus.publish` | 只能发布 `<自己的 id>:` 前缀的 topic | — |
| `bus:subscribe` | `ctx.bus.subscribe` | **用了这个 API 就要声明**（不声明会在激活时被拒）。声明之后，订阅自己前缀仍然不需要额外授权，只有订别人/宿主的 topic 才再走一层 ACL | — |
| `storage` | `ctx.storage.*` | 每插件独立 JSON 存储，宿主按 id 隔离落盘 | 风险 |
| `ble:scan` | `ctx.ble.startScan/stopScan` | 蓝牙扫描 | — |
| `ble:connect` | `ctx.ble.connect/disconnect/connectedDevice` | 连接与订阅通知 | — |
| `widget` | `ctx.widget.update` | 向自己的 widget 推数据（走 `<id>:widget` topic） | — |
| `overlay` | `ctx.overlay.show(opts?)` / `hide` / `destroy` | **本插件专属**的透明悬浮窗（窗口标签 `overlay-<你的 id>`）。`show({ placement: "above-pet", height: 104 })` 让它贴着宠物头顶并跟随拖动；不传就是桌面左上角 | — |
| `http` | `ctx.http.request` | 出站请求，**按域名逐个再授权**（`http:<host>`，键不带默认端口：`https://x.com` 的键是 `x.com`）。`body` 按响应 Content-Type 的 charset 解码：目前支持 UTF-8 与 GBK/GB2312/GB18030（新浪、腾讯行情这类 GBK 接口能直接拿到中文），其余 charset 与不带 charset 的响应仍按 UTF-8 lossy 解 | 风险 |
| `notify` | `ctx.notify.show` | 系统通知 | — |
| `pet:react` | `ctx.pet.react` | 让宠物插播一个状态，参数只能是 petdex 的九个状态之一：`idle` `running-right` `running-left` `waving` `jumping` `failed` `waiting` `running` `review`（其余名字会被桥拒绝） | — |
| `pet:say` | `ctx.pet.say` | 让宠物弹一句台词 | — |
| `agent:hooks` | `ctx.host.agentHooks.{status,install,uninstall}` | 查询/安装/卸载本机编码 Agent（Qoder）的 hook 配置（`~/.qoder*/settings.json` 里自家 `--pet-hook` 条目，增删只动自己的）。**只在插件设置页（`settings` 区 widget）可用**：`badge` / `overlay` 区与宠物窗里没有 `ctx.host`。首次调用弹同意框；这是本项目第一个"能改用户其他应用配置"的能力，边界见 ADR-0001 | 风险 |

## 4. ctx API

```js
export async function activate(ctx) {
  ctx.log("启动", ctx.pluginId);

  // 存储（值是任意 JSON）
  const cfg = (await ctx.storage.get("config")) ?? {};
  await ctx.storage.set("config", { ...cfg, mode: "badge" });

  // 事件总线。subscribe 返回的是 Promise（要先过权限校验），
  // 需要提前退订就 await 它拿到退订函数；不处理的话停用时宿主会回收
  ctx.bus.subscribe("ble:heart-rate", ({ bpm }) => ctx.widget.update({ bpm }));
  ctx.bus.publish(`${ctx.pluginId}:status`, { text: "已连接" });

  // 网络：首次访问某个域名会弹一次授权框
  const res = await ctx.http.request("https://api.example.com/tokens", {
    method: "GET",
    headers: [["authorization", "Bearer ..."]],
  });
  // res: { status, content_type, body, truncated }，body 上限 1 MiB
  // body 按响应 Content-Type 的 charset 解码，目前支持 UTF-8 与 GBK/GB18030，其余仍按 UTF-8 lossy

  ctx.notify.show("同步完成", "本次 1.2k tokens");
  ctx.pet.react("jumping"); // 九状态之一：idle/running-right/running-left/waving/jumping/failed/waiting/running/review
  ctx.pet.say("同步好啦");
}
```

### topic 命名空间规则

topic 形如 `<插件 id>:<名字>`，`<插件 id>` 前缀归该插件所有；其余（`ble:heart-rate`、`host:*` 等）归宿主。

- **发布**：只能发自己前缀，且不能是通配。宿主原生 topic 由宿主注入，插件伪造不了。
- **订阅**：调用 `ctx.bus.subscribe` 本身就要声明 `bus:subscribe`；声明之后，自己前缀随便订（含 `你的id:*`），订宿主或他人的 topic 需要**精确名字**，且**不允许通配**（`*` 和 `别人:*` 会被拒，防止一次性窃听所有人的指令通道）。
- 标准事件名：`ble:heart-rate`、`ble:device-found`、`ble:disconnected`、`agent:state`（编码 Agent 的会话总状态，只在变化时广播，带递增 `counter`）、`agent:event`（单条 hook 事件：`phase` / `toolName` / `detail` / `steps` / `title` / `notificationKind`，每次工具调用都发；工具失败这类「总状态里仍算进行中」的信号只能从这里拿）、`llm:token-usage`、`com.pet.todo:changed`。

多个文件共享 topic 常量时，抽一个 `topics.js` 让 `index.js` 与 `widget.js` 各自 `import`（插件文件由宿主按目录提供，相对 import 在开发和打包版都能解析）。别在两个文件里各写一遍字符串。

标准 topic 的常量定义在 `packages/sdk/topics.js`（SDK 侧的唯一定义处，类型见 `packages/sdk/topics.d.ts`），但**插件内仍写字面串** —— 插件从磁盘加载、运行时导不到 `packages/`，两侧的一致性由离线单测 `tests/unit/unit-sdk-topics.mjs` 反向钉住，改任一边测试即红。

## 5. widget 约定

```js
export function mount(root, ctx) {
  // root 是 closed ShadowRoot，你的 DOM 全在里面，宿主样式互不影响
  // ctx = { pluginId, region, bus }（Worker 路线再加 dom / onLayout / onCanvas，见 5.1）
  // region: 'badge'（宠物旁）| 'overlay'（悬浮层）| 'settings'（设置窗）
}
export function unmount(root) { /* 用 root 找回自己那份清理表 */ }
```

必须遵守的三条：

1. **不要碰宿主 DOM 或 canvas**，只往 `root` 里写。
2. **清理表按挂载实例存，不要用模块级数组**。同一个 widget 文件会同时在 badge/overlay/settings 三个区域被挂载，模块级数组会让第一个卸载的人把别人的退订函数全清空，导致订阅永久泄漏。推荐用 `WeakMap` 以 `root` 为键。
3. **设置面板必须回显当前配置**。面板是在别的窗口里新建的，拿不到插件的历史数据；直接渲染模板默认值会出现「配置没保存」的错觉，而且用户一动某个开关，就把面板里没显示出来的另一项一起写回默认。做法：状态每次变化都 `ctx.widget.update(当前配置)`，面板挂载时订阅 `${PID}:widget` 并据此控件。宿主会为 `*:widget` 保留最近一份、在新订阅建立时回灌一次（`bus_peek`），但**这只在你真的推送过配置之后有效**——别把它当成免写 `widget.update` 的理由。
4. **外部数据一律走 `textContent`，绝不拼进 `innerHTML`**。BLE 广播名、HTTP 响应、其他事件 payload 都算不可信输入；Shadow DOM 不阻止 `<img onerror>` 执行。同理，不要把外部值拼进 CSS 选择器。

`settings` 区出现在**设置窗的插件页**里：侧栏一个插件一条，点进去之后，宿主给的是壳（插件名/版本/id/描述、启停开关、权限列表与「撤销授权」），中间那块「插件页面」整个交给你渲染。宿主不解释其内容，也不会在插件停用时保留它 —— 未启用的插件不会挂载，用户看不到你的页面时也不会挂着你的实例。想让插件页里放展示型内容（不只是表单）也完全可以，这块区域就是你的插件页。

`ctx.bus` 是宿主注入的**受限视图**，只有 `publish`/`subscribe` 两个方法，且每次调用都按上面第 4 节的规则校验。

### 5.1 渲染契约（Worker 路线，ADR-0008）

widget 默认就跑在自己的模块 Worker 里：那里**没有 `window` / `document` / `localStorage`**，
渲染靠发指令。宿主侧留着一把逃生门 —— `localStorage` 的 `host:widget-realm-plugin-host`
（逗号分隔插件 id）能把某个 widget 放回宿主 realm，只服务「还没照下面这张表改写的老 widget」，
不是给你调风格用的配置项。两条路各跑各的：留在宿主 realm 时 `ctx.dom` / `onLayout` / `onCanvas`
**是 undefined**，照契约写的 widget 会白屏。
哪个 realm 在跑可以从插槽壳上看：`div[data-plugin-id="<id>"]` 的 `data-widget-realm` 是 `host`、`worker` 还是 `blocked`。

**照契约写完要在 manifest 声明 `"apiVersion": 2`。** 宿主按这个声明分流，判定在加载 widget 之前：
没声明（或写 1）又没被点名留宿主 realm 的 widget，代码一行都不执行，宿主在插槽里放一张说明卡
（`data-widget-realm="blocked"`；badge 区只显示一行「⚠ widget 需迁移」，全文在悬停提示与控制台 `warn` 里），
而不是让它进 Worker 撞上 `document is not defined`、插槽被收掉、用户只看见一块白。

进 Worker 之后 `ctx` 多三个键，写代码时按「只有这一面」来写：

| 旧写法 | 契约写法 | 差在哪 |
|---|---|---|
| `document.createElement("span")` | `ctx.dom.createElement("span")` | 标签名要在白名单里，表外**当场拒收**（不报错，是不渲染） |
| `el.innerHTML = "<b>…</b>"` | 逐节点 `createElement` + `append` | **没有 `html` 指令**：插件能注入任意标记就等于把安全边界打开 |
| `root.querySelector(".x")` | 自己留着那个节点的引用 | 没有查询语义。要按状态找节点，就把句柄存进挂载实例的表里（第 2 条清理表同一份） |
| `el.addEventListener("keydown", h)` | `el.on("keydown", e => …)` | 回调收到的是**快照**不是事件对象：`e.key`，`value` / `checked` 读 `e.target` |
| `e.preventDefault()` | `el.on("keydown", h, { preventDefault: true })` | 拦不拦由**订阅时**声明，handler 里改不了 |
| `document.createTextNode("x")` | 包一层 `span`，把文字写进它的 `textContent` | 契约里**没有文本节点**这个概念，也没有对应 op；行内文字用 span 等价 |
| `window.addEventListener("resize", …)` | `ctx.onLayout(l => …)` | 尺寸与 dpr 由宿主观测后推给你，你量不了自己 |
| `canvas.getContext("2d")` | `ctx.onCanvas((id, cv) => cv.getContext("2d"))` | 画布控制权交接给 Worker，交接后主线程再也画不了它 |

节点句柄（`WidgetNode`）是个**闭集**：`textContent` / `className` / `classList` / `dataset` / `style.属性` /
`value` `checked` `disabled` `readOnly` `placeholder` `type` `id` / `setAttribute` / `append` / `appendChild` /
`replaceChildren` / `remove` / `on` / `off` / `nodeId`。没有 `children`、没有 `firstChild`、
没有 `getBoundingClientRect`、没有 `style.cssText`。注意 `id` 有两写：写的是 DOM 的 `id` property，
`dataset.x` 才是 `data-x` 属性 —— 迁移时 `setAttribute("id", …)` 换成 `.id = …`，别写成 `dataset.id`。词表的唯一真相是 `src/runtime/widget-protocol.ts` 那五张名单（标签 / SVG / 属性 /
样式属性 / 事件），本文只指路不抄表 —— 抄了就会漂。

三条容易踩的：

1. **别指望扩面**。widget 的调用面比入口窄：只有 `bus.publish` / `bus.subscribe`，加上 settings 区的
   `agentHooks.*`。`storage` / `http` / `pet.*` 在 Worker 路线里也拿不到 —— 它们在宿主 realm 里同样拿不到，
   搬迁不扩权。要开得先改 ADR。
2. **表外名字是静默拒收**，不是异常。宿主拒收 64 次后这个挂载实例自锁。调试时在控制台看 `console.debug`
   那几条（拒收是正常契约路径，所以不打 `warn`）。
3. **批次在微任务里合并**。一次 `mount()` 里连发 50 条指令是一条消息，不必自己攒；但也别指望它同步落地，
   量不到自己刚写的节点。
4. **要读用户输入的当前值，必须订阅 `input`**。快照会把 `value` / `checked` 写回节点，但宿主只对
   **登记过监听**的节点回推事件；没订阅 `input`，你在 `keydown` 里读到的还是旧值。
   「回车提交输入框」那种写法就栽在这里（A10 实测踩到）。
5. **停用钩子两个名字都认**：`unmount(root)`（宿主 realm 一直用的）与 `deactivate(root)`（Worker 侧新名），
   两个都导出时只调 `deactivate` —— 调两次等于重复退订。老插件迁进来不必改导出名。

## 6. 共享资源

BLE 会话与扫描是**全插件共享**的单一资源。宿主按插件记账：`ctx.ble.disconnect()` 只在"你是最后一个持有者"时才真正释放；停用某个插件也不会掐断别的插件正在用的会话。所以你可以放心调用清理，不必担心误伤。overlay 悬浮窗**不共享**：宿主按插件各开一扇（`overlay-<id>`），`hide()` / `destroy()` 只影响你自己那扇。

宠物被游戏模式隐身时，宿主会把 overlay 一起收掉（你不需要处理），恢复显示时按你当时的意愿重新显示 —— 也就是说 `hide()` 过就不会再出现。

overlay 的**摆放与尺寸属于你自己那扇窗**：`show()` 传什么就按什么建，窗口已存在时再 `show()` 会按新参数调整高度与摆放方式，不会影响别的插件的悬浮层。插件停用时宿主会 `destroy` 掉它的悬浮窗，你不需要自己收尾（`deactivate()` 里调 `destroy()` 也无害）。

## 7. 调试

```bash
npm run dev:debug     # 终端 1：带 WebView2 远程调试端口启动
npm run verify        # 终端 2：跑隔离/权限/渲染回归（147 条断言）
```

- 插件代码改动后在设置窗里把该插件关掉再打开即可生效（模块 URL 带文件修改时间，不会命中旧缓存）；
  也可以刷新宠物窗（`Ctrl+R`）。Vite 不 watch `plugins/`，不会自动热重载。
- 宿主侧日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`，以及 dev 终端与 webview console。
- **CSP 只在打包版生效**（`tauri dev` 的页面由 Vite 直出，Tauri 无从注入策略）。要验证 CSP，跑 `npm run verify:release`。

## 8. 已知边界

插件是**同 realm 的普通 JS**，不是硬安全边界：一个蓄意恶意的插件可以绕过 JS 能力桥直接调宿主命令。宿主侧能强制的部分（manifest 声明校验、目录名一致性、同意框来源绑定、存储路径隔离、topic 归属、BLE 与 http 的授权表校验、跨会话开关只认设置窗）已在 Rust 侧落实并有回归覆盖；真正的进程级隔离需要切换到 Web Worker 宿主，届时本 SDK 的 API 面保持不变。

两点具体口径，写插件时值得知道：

- `ctx.http.request` 的重定向由宿主**逐跳**跟进并重新校验域名：你授权过的域名 302 到一个没授权的主机，请求会失败（而不是悄悄访问到内网或元数据端点）。跨主机跳转时 `authorization` / `cookie` 头不会带过去。
- 撤销授权、查看授权表、装形象、改快捷键、开自启这一类命令**只认设置窗**。你自己的插件页面在 overlay/settings 窗里跑，也拿不到这些命令。
