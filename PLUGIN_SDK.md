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

## 2. 生命周期

```js
export async function activate(ctx) { /* 宿主在启用时调用一次 */ }
export async function deactivate() { /* 停用/移除时调用 */ }
```

- `activate` 抛错只隔离该插件，宿主把错误广播给设置窗红条，不会崩宿主。
- 插件的 `permissions` 在首次激活时**一次性**弹框请求；用户拒绝则该插件本次不激活。

## 3. 能力清单

未声明的能力调用会被**宿主直接拒绝**（不是弹框），所以 `permissions` 要写全。

| 能力名 | 授予的 API | 说明 |
|---|---|---|
| `bus:publish` | `ctx.bus.publish` | 只能发布 `<自己的 id>:` 前缀的 topic |
| `bus:subscribe` | `ctx.bus.subscribe` | 订阅**别人或宿主**的 topic 才需要；订阅自己前缀无需声明 |
| `storage` | `ctx.storage.*` | 每插件独立 JSON 存储，宿主按 id 隔离落盘 |
| `ble:scan` | `ctx.ble.startScan/stopScan` | 蓝牙扫描 |
| `ble:connect` | `ctx.ble.connect/disconnect/connectedDevice` | 连接与订阅通知 |
| `widget` | `ctx.widget.update` | 向自己的 widget 推数据（走 `<id>:widget` topic） |
| `overlay` | `ctx.overlay.show/hide/destroy` | 桌面左上角透明悬浮层 |
| `http` | `ctx.http.request` | 出站请求，**按域名逐个再授权**（`http:<host>`） |
| `notify` | `ctx.notify.show` | 系统通知 |
| `pet:react` | `ctx.pet.react` | 让宠物插播一个动作 |
| `pet:say` | `ctx.pet.say` | 让宠物弹一句台词 |

## 4. ctx API

```js
export async function activate(ctx) {
  ctx.log("启动", ctx.pluginId);

  // 存储（值是任意 JSON）
  const cfg = (await ctx.storage.get("config")) ?? {};
  await ctx.storage.set("config", { ...cfg, mode: "badge" });

  // 事件总线
  ctx.bus.subscribe("ble:heart-rate", ({ bpm }) => ctx.widget.update({ bpm }));
  ctx.bus.publish(`${ctx.pluginId}:status`, { text: "已连接" });

  // 网络：首次访问某个域名会弹一次授权框
  const res = await ctx.http.request("https://api.example.com/tokens", {
    method: "GET",
    headers: [["authorization", "Bearer ..."]],
  });
  // res: { status, contentType, body, truncated }，body 上限 1 MiB

  ctx.notify.show("同步完成", "本次 1.2k tokens");
  ctx.pet.react("react");
  ctx.pet.say("同步好啦");
}
```

### topic 命名空间规则

topic 形如 `<插件 id>:<名字>`，`<插件 id>` 前缀归该插件所有；其余（`ble:heart-rate`、`host:*` 等）归宿主。

- **发布**：只能发自己前缀，且不能是通配。宿主原生 topic 由宿主注入，插件伪造不了。
- **订阅**：自己前缀随便订（含 `你的id:*`）；订宿主或他人的 topic 需要声明 `bus:subscribe`，且**不允许通配**（`*` 和 `别人:*` 会被拒，防止一次性窃听所有人的指令通道）。
- 标准事件名：`ble:heart-rate`、`ble:device-found`、`ble:disconnected`、`llm:token-usage`、`todo:changed`。

多个文件共享 topic 常量时，抽一个 `topics.js` 让 `index.js` 与 `widget.js` 各自 `import`（插件文件由宿主按目录提供，相对 import 在开发和打包版都能解析）。别在两个文件里各写一遍字符串。

## 5. widget 约定

```js
export function mount(root, ctx) {
  // root 是 closed ShadowRoot，你的 DOM 全在里面，宿主样式互不影响
  // ctx = { pluginId, region, bus }
  // region: 'badge'（宠物旁）| 'overlay'（悬浮层）| 'settings'（设置窗）
}
export function unmount(root) { /* 用 root 找回自己那份清理表 */ }
```

必须遵守的三条：

1. **不要碰宿主 DOM 或 canvas**，只往 `root` 里写。
2. **清理表按挂载实例存，不要用模块级数组**。同一个 widget 文件会同时在 badge/overlay/settings 三个区域被挂载，模块级数组会让第一个卸载的人把别人的退订函数全清空，导致订阅永久泄漏。推荐用 `WeakMap` 以 `root` 为键。
3. **外部数据一律走 `textContent`，绝不拼进 `innerHTML`**。BLE 广播名、HTTP 响应、其他事件 payload 都算不可信输入；Shadow DOM 不阻止 `<img onerror>` 执行。同理，不要把外部值拼进 CSS 选择器。

`ctx.bus` 是宿主注入的**受限视图**，只有 `publish`/`subscribe` 两个方法，且每次调用都按上面第 4 节的规则校验。

## 6. 共享资源

BLE 会话与 overlay 悬浮层是**全插件共享**的单一资源。宿主按插件记账：`ctx.ble.disconnect()` / `ctx.overlay.hide()` 只在"你是最后一个持有者"时才真正释放；停用某个插件也不会掐断别的插件正在用的会话。所以你可以放心调用清理，不必担心误伤。

## 7. 调试

```bash
npm run dev:debug     # 终端 1：带 WebView2 远程调试端口启动
npm run verify        # 终端 2：跑隔离/权限回归（79 条断言）
```

- 插件代码改动后刷新宠物窗即可（`Ctrl+R`）；Vite 不再 watch `plugins/`，不会自动热重载。
- 宿主侧日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`，以及 dev 终端与 webview console。
- **CSP 只在打包版生效**（`tauri dev` 的页面由 Vite 直出，Tauri 无从注入策略）。要验证 CSP，跑 `npm run verify:release`。

## 8. 已知边界

插件是**同 realm 的普通 JS**，不是硬安全边界：一个蓄意恶意的插件可以绕过 JS 能力桥直接调宿主命令。宿主侧能强制的部分（manifest 声明校验、目录名一致性、同意框来源绑定、存储路径隔离、topic 归属）已在 Rust 侧落实并有回归覆盖；真正的进程级隔离需要切换到 Web Worker 宿主，届时本 SDK 的 API 面保持不变。
