# Pet — Windows 桌面宠物插件化框架

一个插件驱动的 Windows 桌面宠物：宠物本体只提供窗口、渲染和插件运行时，所有功能（心率蓝牙广播、大模型 token 用量、待办事项等）由插件提供，面向第三方开放插件生态。

## 当前状态

- **阶段**：框架与插件运行时已落地并有运行时回归（2026-09-29）。
- **已完成**：宠物窗（Petdex 图集九状态 + 状态机 + 呼吸/轻摆渲染层 + 点击穿透）、Petdex 桌宠资源安装（设置窗按名字下载、默认 `deepseek`）、插件运行时、Rust 能力服务（ble / store / http / notify / 权限同意框 / Agent hook 收件）、设置窗（含 Agent hook 安装与游戏模式开关）、透明 overlay 悬浮窗、心率蓝牙与 Agent 桥两个示例插件。
- **未完成**：`todo` 与 `llm-token-usage` 两个示例插件（用户已明确暂缓）。
- 完整设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；插件作者文档见 [PLUGIN_SDK.md](PLUGIN_SDK.md)。

## 技术决策（已确认，勿重新选型）

| 项 | 决策 |
|---|---|
| 宿主框架 | Tauri 2（Rust），不用 Electron / .NET / Python |
| 前端 | TypeScript + Vite，不引入重框架，Canvas2D 渲染宠物 |
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
4. **三个示例插件**：`heart-rate-ble` ✅；`todo`、`llm-token-usage` 暂缓（用户决定）
5. **文档收尾**：[PLUGIN_SDK.md](PLUGIN_SDK.md) ✅
6. **桌宠形象改由 Petdex 提供**：九状态图集渲染 ✅ + 设置窗按名字安装 + 默认形象 `deepseek`（本波次）

## 验收标准

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用 ✅
- plugins/ 目录放入/移除插件后生效 ✅（目录 watcher + 设置窗启停）；单插件异常不崩溃宿主 ✅
- 有应用全屏时宠物自动隐身并停止动画，退出后恢复 ✅（`npm run verify:game` 15 条）。隐身由宿主命令 `set_pet_hidden` 统一负责：宠物窗与贴在它身上的 overlay 悬浮 UI（状态卡、心率波形）一起收放，恢复时按插件当时的意愿重新显示
- 心率插件可扫描/连接并显示实时 BPM ✅；`todo`、`token` 插件未做
- 断开后可直接重连同一设备，不必重新扫描（代码级修复：扫描不再清空句柄缓存，缓存未命中时回落 `adapter.peripherals()`）。**本机无蓝牙硬件，未经真实心率设备验证**
- 设置窗安装 Qoder hook 后，Agent 的工具调用/等确认/结束/失败能驱动宠物 ✅（`npm run verify:agent` 43 条断言）。**已用真实 Qoder 会话验证**：hook 确实被调用、事件按形状落盘并驱动宠物；状态卡贴在宠物头顶显示会话状态、工具名与步数，一轮结束 3 秒后自动收起
- 未授权能力调用被拒绝且触发同意框 ✅；SDK 文档 ✅
- 宠物按 petdex 九状态播放真序列帧（图集 8×9 / 8×11、单元格 192×208）✅（`npm run verify` 的「petdex 图集几何与九状态切片」组）
- 设置窗输入 Petdex 名字（如 `deepseek`）即从公开画廊下载并换装，默认形象 `deepseek`，切换不必重启 ✅（`npm run verify:skin` 25 条：真网络安装 boba、目录穿越被拒、安装类命令只认设置窗、换装后宠物窗不重启就解码新图集、删掉当前形象回落默认）。已用真实截图确认宠物窗里播的就是画廊下载的 deepseek
- 上述大部分由 `npm run verify` 的运行时断言把守（见「约定」），不是靠人工回归

## 约定

- 标准事件 topic：`ble:heart-rate`、`agent:state`（`running｜needs_input｜completed｜idle`，只在变化时广播）、`agent:event`（细粒度 hook 事件：phase / toolName / detail / steps / title，每次工具调用都发）、`llm:token-usage`、`todo:changed`
- 宿主窗口事件（不是总线 topic，插件收不到）：`host:fullscreen`（`{active,title}`，最近 3 次采样的多数票）
- Agent 会话状态：`Stop` 之后 2 秒内到达的 pre/post 算迟到事件，不再把会话打回 running（否则卡片会挂着「正在执行」直到 90 秒 TTL 过期）；新一轮的 user-prompt/session-start 立刻作废该宽限期
- topic 归属：`<插件id>:` 前缀归该插件。插件只能**发布**自己前缀；订阅他人/宿主 topic 需声明 `bus:subscribe`，且**不允许通配**越过自己的前缀
- 能力名见 PLUGIN_SDK.md 第 3 节；新增能力时要同时更新桥、Rust 校验与那份表格
- 共享资源（BLE 会话、overlay 单窗）按插件持有者计数，释放只对真正的持有者生效
- 插件存储位置：`%APPDATA%/com.desktoppet.pet/plugins/<id>`（插件间隔离，撤销授权会连带清目录）
- 首批插件目录：`plugins/com.pet.hr-ble`（已做）、`plugins/com.pet.agent-bridge`（已做：订阅宿主 `agent:state` 把编码 Agent 的会话状态转成宠物反应）、`plugins/todo`、`plugins/llm-token-usage`（暂缓）
- **验证**：`npm run dev:debug` + `npm run verify`（WebView2 CDP 驱动真实 webview 的回归断言，覆盖隔离、权限、热安装、渲染几何）；`npm run verify:game` 单跑游戏模式（真起一个全屏窗口当触发源）；注意它会用 ALT 注入抢前台 10~16 秒，期间别的 topmost 程序（聊天软件通知窗）可能被顶上来闪动，那是测试脚本的副作用不是应用冲突；`npm run verify:agent` 单跑 Agent 桥端到端（脚本直接往 Agent 收件目录写事件，宿主 watcher 负责归一化）；`npm run verify:skin` 单跑桌宠资源安装链路（会真的连 petdex.dev 下载并临时装一个第二形象，跑完自动删掉）；`npm run verify:release` 单独验打包版 CSP，每波次收尾手工跑一次（约 3~4 分钟构建）
- Agent 接入约定：hook 事件由宿主自己收 —— `--pet-hook <phase>` 分支在建窗之前分流，落成 `agent/inbox/<phase>.jsonl`，watcher 读增量并归一化成会话状态后广播。不读 petdex、不开本地端口。phase 必须命中白名单（它同时是文件名与 CLI 参数）；安装/卸载只按 `--pet-hook` 标记增删自己的条目，不动其他 hook，写配置前先备份且原子落盘。
- 状态词表：**只有 petdex 的九个状态** `idle / running-right / running-left / waving / jumping / failed / waiting / running / review`（行号、每行帧数与整行时长见 `src/pet/petdex-states.ts`）。原来的 12 个自造状态（walk/greet/sleep/react/curious/teasing/blush/angry/night）已取消，别再往回加。`ctx.pet.react()` 只认这九个名字，Agent 桥的 phase→状态映射也照搬 petdex 的 `stateForEvent`
- 桌宠资源：磁盘位置只有 Rust `services/skins.rs` 的 skins 目录一个解析点，经 `petskin://<slug>/sprite.webp`（Windows 上即 `http://petskin.localhost/…`）读给 webview；打包版 CSP 的 `img-src` 必须包含 `http://petskin.localhost`，否则只有 `tauri build` 产物会黑屏（dev 不注入 CSP，测不出来）。名字解析走公开接口 `https://petdex.dev/api/manifest/v2`（`pets` 是数组的数组，列序由其 `fields` 给出，别硬编下标）
- 宿主日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`
- 桌宠资源：磁盘位置只有 Rust `services/skins.rs` 的 skins 目录一个解析点，经 `petskin://<slug>/sprite.webp`（Windows 上即 `http://petskin.localhost/…`）读给 webview；打包版 CSP 的 `img-src` 必须包含 `http://petskin.localhost`，否则只有 `tauri build` 产物会黑屏（dev 不注入 CSP，测不出来）。名字解析走公开接口 `https://petdex.dev/api/manifest/v2`（`pets` 是数组的数组，列序由其 `fields` 给出，别硬编下标）
