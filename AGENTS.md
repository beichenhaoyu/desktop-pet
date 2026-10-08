# Pet — Windows 桌面宠物插件化框架

一个插件驱动的 Windows 桌面宠物：宠物本体只提供窗口、渲染和插件运行时，所有功能（心率蓝牙广播、大模型 token 用量、待办事项等）由插件提供，面向第三方开放插件生态。

## 当前状态

- **阶段**：框架与插件运行时已落地并有运行时回归（2026-09-29）。按 [docs/CODE-REVIEW.md](docs/CODE-REVIEW.md) 的 45 条评审意见做完一波修复（2026-10-08）：P0/P1/P2 里成立的部分全部落地并有断言，评审自身的两条误判记在「约定」末尾。
- **已完成**：宠物窗（Petdex 图集九状态 + 状态机 + 呼吸/轻摆渲染层 + 点击穿透）、Petdex 桌宠资源安装（设置窗按名字下载、默认 `deepseek`）、插件运行时、Rust 能力服务（ble / store / http / notify / 权限同意框 / Agent hook 收件）、设置窗（分区导航 + 插件搜索 + 桌宠形象 + 全局快捷键 + 开机自启 + Agent hook + 游戏模式）、按插件分开的透明 overlay 悬浮窗、心率蓝牙 / Agent 桥 / 待办三个示例插件。
- **未完成**：`llm-token-usage` 示例插件（用户已明确暂缓）。
- **评审波次（2026-10-08）**：[docs/CODE-REVIEW.md](docs/CODE-REVIEW.md) 的 45 条已逐条核过并修掉可复现的部分。两条不成立，别再照着"修"：P0 #1（Tauri 2 的 `Window::emit` 走 `manager().emit`，本来就向全部 webview 广播，跨窗总线一直是通的，`verify:todo` 的桌面卡片就是它的运行时证据）；P2 #32（`request()` 里 includes 与优先级判断的先后没有可观察差异 —— 会打断的请求根本不进队列）。
- 完整设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；插件作者文档见 [PLUGIN_SDK.md](PLUGIN_SDK.md)。

## 技术决策（已确认，勿重新选型）

| 项 | 决策 |
|---|---|
| 宿主框架 | Tauri 2（Rust），不用 Electron / .NET / Python |
| 前端 | TypeScript + Vite，不引入重框架，Canvas2D 渲染宠物 |
| 开机自启 / 全局快捷键 | `tauri-plugin-autostart` + `tauri-plugin-global-shortcut`（官方插件，不自写注册表与 RegisterHotKey）。加依赖后必须核对 `cargo tree -p tauri`：本项目踩过「cargo 把 tauri 抬到新 minor，npm 侧 `@tauri-apps/*` 没动 → `tauri build` 直接失败」，当前锁 tauri 2.12.0 且 Cargo.lock 入库，收尾必跑 `npm run verify:release`。另注意 autostart v2 的扩展方法仍叫 `app.autolaunch()`（改名 `autostart()` 排到 v3） |
| 宠物形象 | Petdex 图集（8 列 × 9 行 v1 / × 11 行 v2，单元格 192×208 无损 webp）+ 状态机；状态词表照搬 petdex 九个状态，本项目不内置美术，运行时从公开画廊下载，默认 `deepseek` |
| 插件形态 | WebView 内 ES Module（进程内加载），每个插件 = manifest.json + index.js |
| 插件生态 | 面向第三方开放：manifest 权限声明 + 能力受控桥 + 首次授权弹窗 |
| BLE | Rust `btleplug`（WinRT 后端）；若 Windows 广播数据受限，回退 `windows` crate 的 BluetoothLEAdvertisementWatcher |
| 插件文件来源 | 宿主自定义协议 `petplugin://<id>/<相对路径>`（Windows 上即 `http://petplugin.localhost/…`），磁盘位置只有 `plugins_dir()` 一个解析点。**不要**回到构建时把 `plugins/` 复制进 `dist/` 的做法——那会让"放进目录即生效"在打包版失效；asset 协议 + 配置 scope 也不可用，`$CARGO_MANIFEST_DIR` 在 dev 下不展开会 403 |

**安全边界共识**：进程内 JS 插件不是硬安全边界，v1 以「manifest 权限声明 + 能力校验 + 首次授权弹窗」做策略层；桥接 API 面向未来设计，后续可平滑切换到 Web Worker 宿主实现真隔离。为此插件不得直接操作 DOM/画布，widget 一律运行在各自的 Shadow DOM 容器内。

已落到 Rust 侧、有回归断言覆盖的部分：请求的能力必须等于 manifest 声明（`http:<host>` 视为被 `http` 覆盖）、同意框只能由它自己的窗口应答、插件目录名必须等于 manifest.id、`bus_publish` 的 origin 由宿主按调用窗口判定、存储按 id 隔离且原子写。**仍然拦不住的**：同 realm 的插件自己 `import { invoke }` 绕过 JS 桥（多插件共用宠物窗，宿主无法从窗口身份区分是哪个插件）—— 这条要等 Web Worker 宿主才能收口，改动时不要假装它已解决。

**CSP 只在打包产物生效**：`tauri dev` 的文档由 Vite 直出，Tauri 没有注入点，`devCsp` 同样无效；打包版则以 `content-security-policy` **响应头**下发（文档里没有 meta）。判 CSP 是否强制不能用 CDP/DevTools 发起的求值（不受 CSP 约束），要看页面自身代码的副作用。

## 架构速览

- **WebView 侧**：宠物渲染状态机（动画优先级队列）；Widget 宿主（每插件一个 Shadow DOM 插槽）；插件运行时（manifest 扫描 → 动态 import → activate/deactivate 生命周期，单插件错误隔离）；事件总线（topic 格式 `plugin-id:topic`）；PetAPI 能力桥（按 manifest 权限逐项校验，拒绝默认）。
- **Rust 宿主侧**：窗口管理（透明/置顶/点击穿透/拖拽）、托盘、单实例、自启；原生能力服务 ble / store（插件隔离 JSON 存储）/ http（白名单域名代理）/ notify / agent（Qoder hook 收件与状态归一化）；权限管理（授权记录 + 同意对话框）。

## 实施步骤（按序）

1. **脚手架 + 宠物窗** ✅
2. **插件运行时** ✅
3. **Rust 能力服务** ✅（store / http 白名单代理 / notify / BLE / 权限同意框均已实现）
4. **三个示例插件**：`heart-rate-ble` ✅、`todo` ✅（纯插件、零本体改动）；`llm-token-usage` 暂缓（用户决定）
5. **文档收尾**：[PLUGIN_SDK.md](PLUGIN_SDK.md) ✅
6. **桌宠形象改由 Petdex 提供**：九状态图集渲染 ✅ + 设置窗按名字安装 + 默认形象 `deepseek`（本波次）

## 验收标准

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用 ✅
- plugins/ 目录放入/移除插件后生效 ✅（目录 watcher + 设置窗启停）；单插件异常不崩溃宿主 ✅
- 有应用全屏时宠物自动隐身并停止动画，退出后恢复 ✅（`npm run verify:game` 15 条）。隐身由宿主命令 `set_pet_hidden` 统一负责：宠物窗与贴在它身上的 overlay 悬浮 UI（状态卡、心率波形）一起收放，恢复时按插件当时的意愿重新显示
- 心率插件可扫描/连接并显示实时 BPM ✅；`llm-token-usage` 未做
- 待办插件可增删改勾、桌面卡片、到期提醒，并广播标准 topic `todo:changed` ✅（`npm run verify:todo` 30 条）。字段照 todo.txt 约定，数据只存插件自己的隔离存储
- 断开后可直接重连同一设备，不必重新扫描（代码级修复：扫描不再清空句柄缓存，缓存未命中时回落 `adapter.peripherals()`）。**本机无蓝牙硬件，未经真实心率设备验证**
- 设置窗安装 Qoder hook 后，Agent 的工具调用/等确认/结束/失败能驱动宠物 ✅（`npm run verify:agent` 50 条断言）。**已用真实 Qoder 会话验证**：hook 确实被调用、事件按形状落盘并驱动宠物；状态卡贴在宠物头顶显示会话状态、工具名与步数，一轮结束 3 秒后自动收起
- 设置页两级导航：**侧栏只有「宠物设置」+ 插件列表**（一个插件一条），点插件进去是宿主给的壳（启停 / id / 权限 / 撤销授权）+ 插件自己用 `widget.js` 的 `settings` 区渲染的页面；「宠物设置」里收全部非插件配置（形象 / 快捷键 / 自启 / Agent 接入 / 游戏模式）；搜索框过滤的是插件导航项 ✅（`npm run verify` 的「侧栏结构 / 点插件 → 插件页 / 搜索过滤」三组：切页只留一个面板、停用不挂页且说明原因、启用后 widget 挂进来、离开时摘干净）
- 全局快捷键唤出插件页、开机自启 ✅（非法组合键被拒、`CommandOrControl` 这类跨平台 token 可用、改键成功并归一化、自启与快捷键只认设置窗）
- **点击穿透的原点缓存必须跟着窗口走**：`click-through.ts` 用 `tauri://move` 的**载荷位置**刷新原点（不要再回一趟 `outerPosition`，那会在页面重载时制造在飞 IPC），并保留穿透态下的定期重读兜底。系统拖拽会吞掉 `mouseup`，所以 `main.ts` 以「按键已松开」的 mousemove 认定拖完并复位 `dragEngaged` —— 少了这一步，穿透再也不会上开，宠物整块挡鼠标。真鼠标回归见 `temp` 期手工跑过的 SendInput 三步（第一次能拖、拖完仍可点、能连第二次）
- 未授权能力调用被拒绝且触发同意框 ✅；SDK 文档 ✅
- 宠物按 petdex 九状态播放真序列帧（图集 8×9 / 8×11、单元格 192×208）✅（`npm run verify` 的「petdex 图集几何与九状态切片」组）
- 设置窗输入 Petdex 名字（如 `deepseek`）即从公开画廊下载并换装，默认形象 `deepseek`，切换不必重启 ✅（`npm run verify:skin` 26 条：真网络安装 boba、目录穿越被拒、安装类命令只认设置窗、换装后宠物窗不重启就解码新图集、删掉当前形象回落默认）。已用真实截图确认宠物窗里播的就是画廊下载的 deepseek
- 上述大部分由 `npm run verify` 的运行时断言把守（见「约定」），不是靠人工回归

## 约定

- 标准事件 topic：`ble:heart-rate`、`agent:state`（`running｜needs_input｜completed｜idle`，只在变化时广播）、`agent:event`（细粒度 hook 事件：phase / toolName / detail / steps / title，每次工具调用都发）、`llm:token-usage`、`todo:changed`
- 宿主窗口事件（不是总线 topic，插件收不到）：`host:fullscreen`（`{active,title}`，最近 3 次采样的多数票）
- Agent 会话状态：`Stop` 之后 2 秒内到达的 pre/post 算迟到事件，不再把会话打回 running（否则卡片会挂着「正在执行」直到 90 秒 TTL 过期）；新一轮的 user-prompt/session-start 立刻作废该宽限期
- topic 归属：`<插件id>:` 前缀归该插件。插件只能**发布**自己前缀；订阅他人/宿主 topic 需声明 `bus:subscribe`，且**不允许通配**越过自己的前缀
- 能力名见 PLUGIN_SDK.md 第 3 节；新增能力时要同时更新桥、Rust 校验与那份表格
- 共享资源（BLE 会话、BLE 扫描）按插件持有者计数，释放只对真正的持有者生效；overlay 悬浮窗**按插件各开一扇**（标签 `overlay-<id>`，页面按标签认归属），摆放/尺寸/显隐互不影响 —— 早先共用一扇窗导致「后打开的卡片显示不出来」，改成按插件分开后两扇可同时存在
- 插件存储位置：`%APPDATA%/com.desktoppet.pet/plugins/<id>`（插件间隔离，撤销授权会连带清目录）
- 首批插件目录：`plugins/com.pet.hr-ble`（已做）、`plugins/com.pet.agent-bridge`（已做：订阅宿主 `agent:state` 把编码 Agent 的会话状态转成宠物反应）、`plugins/todo`（已做：id 就叫 `todo`，这样标准 topic `todo:changed` 落在它自己的命名空间里）、`plugins/llm-token-usage`（暂缓）
- `ctx.bus.subscribe` 这个 API **本身**就要在 manifest 声明 `bus:subscribe`，不声明会在激活时被拒（`todo 未在 manifest 声明这些能力: bus:subscribe`）；ACL 放宽的只是「自己前缀不需要额外授权」，别把两者混为一谈
- **验证**：`npm run dev:debug` + `npm run verify`（WebView2 CDP 驱动真实 webview 的回归断言，覆盖隔离、权限、热安装、渲染几何）；`npm run verify:game` 单跑游戏模式（真起一个铺满显示器的窗口当触发源）；该窗**非置顶、任务栏可见、10~16 秒自关**，PowerShell 每轮检查父进程是否存活，脚本被中断时自己收窗不留孤儿；跑它会抢前台，期间别的置顶程序可能短暂闪动，不要在外面套 `timeout`（2026-09-30 就是「全屏 + TopMost + 每 150ms 注 ALT + timeout 杀父进程」把用户会话压垮过一次）；`npm run verify:agent` 单跑 Agent 桥端到端（脚本直接往 Agent 收件目录写事件，宿主 watcher 负责归一化）；`npm run verify:skin` 单跑桌宠资源安装链路（会真的连 petdex.dev 下载并临时装一个第二形象，跑完自动删掉）；`npm run verify:todo` 单跑待办插件端到端（解析/落盘/广播/桌面卡片/回显，跑完撤销授权并下线）；`npm run verify:release` 单独验打包版 CSP，每波次收尾手工跑一次（约 3~4 分钟构建）
- Agent 接入约定：hook 事件由宿主自己收 —— `--pet-hook <phase>` 分支在建窗之前分流，落成 `agent/inbox/<phase>.jsonl`，watcher 读增量并归一化成会话状态后广播。不读 petdex、不开本地端口。phase 必须命中白名单（它同时是文件名与 CLI 参数）；安装/卸载只按 `--pet-hook` 标记增删自己的条目，不动其他 hook，写配置前先备份且原子落盘。
- 状态词表：**只有 petdex 的九个状态** `idle / running-right / running-left / waving / jumping / failed / waiting / running / review`（行号、每行帧数与整行时长见 `src/pet/petdex-states.ts`）。原来的 12 个自造状态（walk/greet/sleep/react/curious/teasing/blush/angry/night）已取消，别再往回加。`ctx.pet.react()` 只认这九个名字，Agent 桥的 phase→状态映射也照搬 petdex 的 `stateForEvent`
- 桌宠资源：磁盘位置只有 Rust `services/skins.rs` 的 skins 目录一个解析点，经 `petskin://<slug>/sprite.webp`（Windows 上即 `http://petskin.localhost/…`）读给 webview；打包版 CSP 的 `img-src` 必须包含 `http://petskin.localhost`，否则只有 `tauri build` 产物会黑屏（dev 不注入 CSP，测不出来）。名字解析走公开接口 `https://petdex.dev/api/manifest/v2`（`pets` 是数组的数组，列序由其 `fields` 给出，别硬编下标）
- 跨会话生效的系统级开关一律**只认设置窗**：`autostart_set`、`hotkey_set`、`hotkey_test`、`permission_list`、`permission_revoke`（与 `pet_skin_install/use/remove`、`agent_hooks_*` 同一套门禁，判定收在 `src-tauri/src/gate.rs`，新增这类命令在那儿加一行即可）；`settings_show` 反过来只认宠物窗，免得插件页面把设置窗弹来弹去。回归要调这些「只认设置窗」的命令，就用 `scripts/cdp.mjs::openSettingsInvoker` 从设置窗发起，别在宠物窗里指望它放行
- **BLE 命令也查授权表**：`ble_start_scan/stop_scan/connect/disconnect/connected_device` 都收 `pluginId` 并逐项校验 `ble:scan`/`ble:connect`（JS 桥负责传）。以前只有桥上面挡着，绕过桥的插件可以自由扫描连接
- **http 的重定向由宿主逐跳跟**：ureq 设 `redirects(0)`，`http.rs::send_following_redirects` 自己走，每一跳的新 host 都要重新过 `http:<host>` 授权（否则授权一个域名就能被 302 弹到内网 / `169.254.169.254`）；跨主机时不带 `authorization`/`cookie`
- **插件身份仍是自报的**：`store_*`、`overlay_*`、`http_request` 的 `pluginId` 由调用方给出，同 realm 里插件 A 冒名 B 仍然拦不住（见上面「仍然拦不住的」，要等 Web Worker 宿主）。已收紧的两条边角：`overlay_show` 只给确实装着的插件开窗；`is_safe_id` 在 Rust 侧与前端 `validateManifest` 的字符集对齐
- overlay 窗口标签把 id 里的 `.` 编码成 `_`（不是 `-`）：id 词表里没有下划线，所以 `a.b` 与 `a-b` 不再抢同一扇窗；回归里的 `overlayLabelFor` 要跟着改
- Agent watcher 的偏移只在**真的消费掉整行**之后才前进（`complete_line_prefix` 有单测）：以前先写偏移再读，hook 写一半时那批事件永久丢
- 运行时的异步生命周期收在三个地方：`plugin-runtime.ts` 每个插件一条串行链（activate/deactivate 排队，弹同意框期间切开关不再产生幽灵激活）、`subscriptions.ts` 由宿主回收插件的总线订阅、`bridge.ts` 缓存会话内已授权的能力并在 `host:permission-revoked` 时失效。插件自己的 `setInterval` 不在回收范围内，仍要自己清
- 插件代码覆盖后免重启：`plugin_file_version` 给出文件 mtime，`pluginFileUrl` 给 `import()` 的 URL 拼 `?v=`（petplugin 协议按 path 找文件，查询串不影响）
- 渲染层不再逐帧烘焙：`SpriteFrame = 源矩形 + 单位化目标矩形`，57 帧共用一份已解码图集（原先 57 张 360×dpr 画布在 dpr=2 时约 118 MB），DPI 变化只需 `fitCanvas` 不必重切片；解码图集缓存按 LRU 限 2 份
- 原子写只有一份实现：`src-tauri/src/fsutil.rs::write_atomic`（tmp 名带 pid），形象 / hook 配置 / 授权表 / 插件存储都走它，别再复制第四份
- std Mutex 一律 `unwrap_or_else(|p| p.into_inner())`：`panic = "abort"` 下释放版是当场 abort，但 dev 与将来可能的 catch 路径里，锁中毒不该放大成整进程退出
- 加速键字符串必须过 `services/hotkeys.rs::normalize_accel` 再注册：至少一个修饰键、恰好一个主键，`CommandOrControl`/`CmdOrCtrl` 这类跨平台 token 要认（默认值本身就用它写成，不认就会导致「恢复默认」失败）
- 宿主日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`
