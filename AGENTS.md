# Pet — Windows 桌面宠物插件化框架

一个插件驱动的 Windows 桌面宠物：宠物本体只提供窗口、渲染和插件运行时，所有功能（心率蓝牙广播、大模型 token 用量、待办事项等）由插件提供，面向第三方开放插件生态。

## 当前状态

- **阶段**：框架与插件运行时已落地并有运行时回归（2026-09-29）。
- **已完成**：宠物窗（鲸鱼娘立绘 + 状态机 + 呼吸/轻摆渲染层 + 点击穿透）、插件运行时、Rust 能力服务（ble / store / http / notify / 权限同意框 / Agent hook 收件）、设置窗、透明 overlay 悬浮窗、心率蓝牙与 Agent 桥两个示例插件。
- **未完成**：`todo` 与 `llm-token-usage` 两个示例插件（用户已明确暂缓）。
- 完整设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；插件作者文档见 [PLUGIN_SDK.md](PLUGIN_SDK.md)。

## 技术决策（已确认，勿重新选型）

| 项 | 决策 |
|---|---|
| 宿主框架 | Tauri 2（Rust），不用 Electron / .NET / Python |
| 前端 | TypeScript + Vite，不引入重框架，Canvas2D 渲染宠物 |
| 宠物形象 | 2D 序列帧 + 状态机（idle/walk/sleep/react），框架内置程序生成的占位宠物 |
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

## 验收标准

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用 ✅
- plugins/ 目录放入/移除插件后生效 ✅（目录 watcher + 设置窗启停）；单插件异常不崩溃宿主 ✅
- 心率插件可扫描/连接并显示实时 BPM ✅；`todo`、`token` 插件未做
- 设置窗安装 Qoder hook 后，Agent 的工具调用/等确认/结束/失败能驱动宠物 ✅（`npm run verify:agent` 21 条断言；用真实 Qoder 会话跑通尚未实测）
- 未授权能力调用被拒绝且触发同意框 ✅；SDK 文档 ✅
- 上述大部分由 `npm run verify` 的运行时断言把守（见「约定」），不是靠人工回归

## 约定

- 标准事件 topic：`ble:heart-rate`、`agent:state`（`running｜needs_input｜completed｜idle`，只在变化时广播）、`agent:event`（细粒度 hook 事件，含 phase 与 toolName）、`llm:token-usage`、`todo:changed`
- topic 归属：`<插件id>:` 前缀归该插件。插件只能**发布**自己前缀；订阅他人/宿主 topic 需声明 `bus:subscribe`，且**不允许通配**越过自己的前缀
- 能力名见 PLUGIN_SDK.md 第 3 节；新增能力时要同时更新桥、Rust 校验与那份表格
- 共享资源（BLE 会话、overlay 单窗）按插件持有者计数，释放只对真正的持有者生效
- 插件存储位置：`%APPDATA%/com.desktoppet.pet/plugins/<id>`（插件间隔离，撤销授权会连带清目录）
- 首批插件目录：`plugins/com.pet.hr-ble`（已做）、`plugins/com.pet.agent-bridge`（已做：只读搭车 petdex 的 `127.0.0.1:7777` 状态端点，把编码 Agent 的会话状态转成宠物反应）、`plugins/todo`、`plugins/llm-token-usage`（暂缓）
- **验证**：`npm run dev:debug` + `npm run verify`（WebView2 CDP 驱动真实 webview 的回归断言，覆盖隔离、权限、热安装、渲染几何）；`npm run verify:agent` 单跑 Agent 桥端到端（脚本自己起一个假的 petdex 状态端点）；`npm run verify:release` 单独验打包版 CSP，每波次收尾手工跑一次（约 3~4 分钟构建）
- Agent 接入约定：`agent-bridge` 只做**消费方**——读 petdex 的 `GET /state`、`GET /bubble`（读侧不鉴权，写侧才要 token）。不要改绑 7777，也不要往 `~/.qoder*/settings.json` 里抢 hook 槽位，那些是 petdex 的位置；要自建推流得另起端口并另立设计。
- 宿主日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`
