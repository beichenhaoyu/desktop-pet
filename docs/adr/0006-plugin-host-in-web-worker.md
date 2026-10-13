# 插件宿主进 Web Worker：身份由宿主分配，IPC 只剩一条受控通道（清单 L1 的方向）

清单第 42 项 L1 要「Web Worker 插件宿主：ADR + 原型（插件身份由宿主分配，不可伪造）」。
**决定：把插件代码从承载窗的 realm 搬进 module Worker；插件身份由宿主在创建 Worker 时分配并绑定到那条
`MessagePort`，Worker 侧不再有 `invoke` 可调；面向插件的 22 个方法改走宿主代理；
widget 的容器与 Shadow DOM 仍留在宿主 realm，Worker 只发渲染指令。**

**为什么算决策**：这是一次真实的换轨，不是"再优化一下"。它会推翻本仓一条写了很久的自我承认 ——
AGENTS.md 的「仍然拦不住的：同 realm 的插件自己 `import { invoke }` 绕过 JS 桥」。
代价是插件生态的加载路径与渲染契约都要重写一遍，所以先把它写死，别让 L2 拆到一半时重新论证。

## 收口的到底是什么（T10 逐条取证的现状，不是推测）

身份链的每一跳都在同一 realm 里传一个**字符串**：磁盘目录名 → `plugins_dir()`（`commands/plugins.rs:77`）→
`collect_manifests`（:99）→ `plugins_list` → 前端 `reconcile`（`plugin-runtime.ts:333`）→
**`buildContext` 里 `const pid = manifest.id`（`src/runtime/bridge.ts:121`）** → 每条 `invoke` 带上这个字符串 →
Rust 侧 `gate::plugin_capability`（`gate.rs:24-37`）只核 `is_safe_id` + `is_granted(id, cap)`。
链条上没有一环能回答「这条 invoke 是哪个插件模块发的」——`pid` 来自 manifest 自述，而 manifest 就在同 realm 可达的地方。

T10 数出的可伪造点里，前 6 条都源于同一个事实：**Worker 里没有 `window`**。
`@tauri-apps/api/core.js:328` 是 `return window.__TAURI_INTERNALS__.invoke(cmd, args, options);`
（同文件 `:72`、`:160` 同样直接取 `window`），所以插件模块在自己 realm 里拿到的是**同一条 IPC**；
而四份 capabilities 文件（`src-tauri/capabilities/`）只列 `core:*` 权限、没列应用命令，
应用命令唯一的闸就是那个认字符串的 `gate.rs`。具体能干什么（逐条依据是派单工作区里 T10 的 `identity.md`；那份产物不入库，所以结论已在下面逐条内联）：

1. 冒名任意**已授权**的 id 调带 `pluginId` 的命令（借能力，不是提权：非法 id 与未声明能力照样被拒）。
2. 冒名发 bus 消息（`bus_publish` 在 pet/settings 那两路采信自报 id）。
3. 直接伪造 `core:event` 事件投递到别的窗口，**绕开 `bus_publish` 的全部 Rust 校验**（`core:default` 含 `core:event:default`）。
4. 窃听全部跨窗中继消息（Rust 把 bus 事件 emit 给所有窗口，无收件人筛选）。
5. `bus_peek` 只查窗型与 `:widget` 后缀，不查 topic 归属 → 读别人最近一份 widget 数据。
6. 设置窗里跑的 widget 代码天然过 `gate::settings` → 能调 `permission_revoke`（撤销任意插件授权并清其存储）、
   `plugin_enabled_set`、`autostart_set`、`hotkey_set`、`pet_skin_*` 这些**纯凭窗口 label 放行**的命令。
7. 同意框里的插件显示名是自报的（能伪造的只有 UI 名字，能力本身仍要 manifest 声明过）。

**本决定的覆盖面**：1–7 全部收口。Worker 里没有 `window` ⇒ 拿不到 `__TAURI_INTERNALS__` ⇒ 没有裸 IPC，
出入只能走宿主给的那条 `MessagePort`；而那条 port 在创建时就绑死了宿主分配的 id，
`gate::settings` 那类 label 门禁也不再被插件代码天然继承（改由宿主侧按 id 代理）。
**不在本决定范围内**：`plugins_list` / `plugin_file_version` 这类宿主运行时自用命令仍无能力门禁——
它们不该暴露给插件，属于 L1 原型里"接口面收窄"的具体一项，不是安全模型漏洞。

## 契约（L1 原型必须遵守的形状）

- **接口面 = 22 个方法**：`buildContext`（`bridge.ts:120-258`）暴露的 19 个（bus 2 / storage 3 / ble 5 / widget 1 / pet 2 /
  http 1 / notify 1 / overlay 3 / log 1）加 `createAgentHooksApi` 的 3 个。（那份表不入库：每个方法背后的命令名我逐条核过都在 `lib.rs:96` 的 48 条注册表里，缺失 0。）Worker 版桥必须覆盖这张表，不许多也不许多年。
- **渲染层留在宿主 realm**：widget 的容器与 Shadow DOM 由宿主持有（`widget-host.ts`），Worker 只发渲染指令。
  四个插件对主文档 realm 的依赖共 84 处，分级是 **W 可做 6 / 需宿主代理 78 / 做不到 0**——
  也就是说没有哪条必须在 Worker 里做不到的事，但绝大多数要么变成消息、要么留在宿主侧。
- **引导形状已由实测定死**（见下一节第 1、2 条）：宿主自己出一个**同源**的 worker 脚本（进 `dist` 的构建产物），
  由它 `import()` 插件的绝对 petplugin URL；相对说明符由宿主在交给 Worker 之前绝对化。
  「让 Worker 直接吃 petplugin URL」「blob:/data: 自举」「宿主 fetch 源码再转 blob」这三条在打包版全部走不通，
  不要再当备选提出。

## 实测结论（2026-10-14 凌晨，PM 起实例量的，不是推理）

方法：临时插件 `zz.worker-probe`（零权限，只跑实验并把读数写进 `globalThis.__probe`）经 petplugin:// 进宠物窗 realm，
外部只用 CDP 读那份副作用 —— 这是本仓判 CSP 的唯一合法姿势（CDP 求值不受 CSP 约束）。
dev 用 `npm run dev:debug`（无 CSP），打包版用 `tauri build --no-bundle` 的 release exe（CSP 以响应头下发，
所以读到的 `meta[http-equiv]` 是 null，照实记）。探针与临时资产测完已全部删除。

| # | 实验 | dev | 打包版（CSP 生效） |
|---|---|---|---|
| A | 直接用 petplugin URL 起 worker | **SecurityError**：脚本与 origin `http://localhost:1420` 不同源 | **同样 SecurityError**（origin 换成 tauri.localhost，规则不变） |
| B | 同源 blob: 起 module worker | 通过；worker 内 `window`/`document`/`localStorage` 全 undefined，`OffscreenCanvas` 是 function | **被 CSP 拦**：Refused to create worker from 'blob:'，违反 `script-src 'self' http://petplugin.localhost 'sha256-…'` |
| C | 经典 blob: worker + importScripts 取 petplugin 脚本 | NetworkError（跨源脚本加载失败） | 先被 CSP 拦（同 B 那条 directive） |
| D | 同源 URL 起 worker | 只有 404 类错误，**没有任何 CSP 报错** | 同样没有 CSP 报错（`'self'` 放行） |
| E | data: URL 起 worker | 构造成功 | **被 CSP 拦** |
| F | 页面 realm `fetch` 插件文件 | 200 | **被 CSP 拦**：违反 `connect-src 'self' ipc: http://ipc.localhost` |
| G | 页面 realm 动态 import 绝对 petplugin URL | 通过（今天的插件就是这么加载的） | 通过 |
| H | **同源 worker 内部** import 绝对 petplugin URL | —— | **通过，插件文件真的被 Worker 取到并执行了** |

由此定下 L1 的形状，一条都不靠猜：

1. **Worker 引导脚本必须是同源资产**（进 `dist` 的构建产物）。A/B/C/E 四条在打包版都走不通：
   petplugin URL 撞跨源规则，blob:/data: 撞 CSP；D 说明 `'self'` 放行，H 说明同源 worker 里 import petplugin 可用。
2. **相对说明符要由宿主绝对化**：H 里 `import('./leaf.js')` 解析成 `http://tauri.localhost/leaf.js` → Failed to fetch。
   插件现有的 `sources/`、`views/settings/` 子模块全是相对引用（astock 一家 26 个文件），
   所以「放进目录即生效」这条产品承诺要在 Worker 侧靠绝对 URL 维持，不能指望 Worker 自己解析。
3. **宿主也别想用 fetch 代取插件源码**（F 被 connect-src 拦）。要么把 petplugin 加进 connect-src（那要再过一次 ADR），
   要么引导脚本用 import 而不是 fetch —— H 已证明 import 这条路通，所以**本波不必改 CSP**。
4. **Worker 里没有 window/document/localStorage**（B/H 实测 undefined）：真隔离成立，
   `bridge.ts:121` 那个自报 id 的伪造面随之消失；「迁移前的旧副本」那条退路也彻底没了。
5. **OffscreenCanvas 在 Worker 里可用**（function），主文档侧 canvas 元素确有 `transferControlToOffscreen`；
   T10 判为 W 的 6 条画布类依赖可以搬，但画布所有权的交接只能在主文档发起。

还剩两条**本波没测**、留给 L1 原型第一天量的：

- 同源引导脚本用 Vite 的 `?worker` 还是 `new URL('./x', import.meta.url)` 形态 —— 两者都会给文件名带 hash，
  影响「绝对化」这一步写在哪儿。
- Worker 里 petplugin 的 cache-busting 查询串（`?v=`）与 H2 的 `no-store` 是否仍够（本次 H 用的是无查询串的固定 URL）。

**判据口径**（本仓踩过的坑，写死）：以上每条都取**页面自身代码的副作用**为准；
拿 CDP 求值判 CSP 会得出「CSP 没生效」的假结论。


## 被否掉的三条路

- **只加一层 `postMessage` shim、插件仍在宿主 realm**：那是伪隔离。上面第 1–3 条一条都收不掉，
  因为 `__TAURI_INTERNALS__` 还是可达——而这正是本项要解决的问题本身。
- **把 DOM/Shadow DOM 一起搬进 Worker**：做不到（Worker 无 DOM），而且会砸掉「每插件一个 Shadow DOM 插槽」
  这条既有安全边界（AGENTS.md「插件不得直接操作 DOM/画布」）。
- **先做 L2 四插件迁移、再回来补 ADR**：L2 是 48h 的量，接口契约里的任何一条（id 绑定方式、渲染指令形状）
  改一次就要重迁四个插件。顺序必须是原型钉死契约 → 再迁移。

## 分期与退出条件

- **L1 原型**：`com.pet.todo` 一个插件在 Worker 里跑通，退出条件是清单原文那句「ADR 获批；todo 插件在 Worker 中跑通」，
  外加一条自定的：**第 1–6 条可伪造点在原型上逐条复现不出**（以前能复现的形状要写成回归断言，见下）。
- **L2 全面落地**：四个插件迁移 + 全部 `verify:*` 通过。`verify-isolation` 里那批「越权尝试被拒」的断言
  要**新增而不是替换**——同 realm 越权用例全部被拒是 L2 的验收，本波先把判据立起来。
- L1/L2 都不改能力名单与授权模型（K3/K4 交付的那套），改的只是「谁在替插件说话」。
