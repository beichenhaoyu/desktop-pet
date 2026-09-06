# Pet — Windows 桌面宠物插件化框架

一个插件驱动的 Windows 桌面宠物：宠物本体只提供窗口、渲染和插件运行时，所有功能（心率蓝牙广播、大模型 token 用量、待办事项等）由插件提供，面向第三方开放插件生态。

## 当前状态

- **阶段**：设计已完成，代码尚未动工（2026-09-06）。
- **第一期目标**：框架 + 三个示例插件，按「实施步骤」顺序推进。
- 完整设计（架构、核心设计、目录结构、验收标准、决策记录）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 技术决策（已确认，勿重新选型）

| 项 | 决策 |
|---|---|
| 宿主框架 | Tauri 2（Rust），不用 Electron / .NET / Python |
| 前端 | TypeScript + Vite，不引入重框架，Canvas2D 渲染宠物 |
| 宠物形象 | 2D 序列帧 + 状态机（idle/walk/sleep/react），框架内置程序生成的占位宠物 |
| 插件形态 | WebView 内 ES Module（进程内加载），每个插件 = manifest.json + index.js |
| 插件生态 | 面向第三方开放：manifest 权限声明 + 能力受控桥 + 首次授权弹窗 |
| BLE | Rust `btleplug`（WinRT 后端）；若 Windows 广播数据受限，回退 `windows` crate 的 BluetoothLEAdvertisementWatcher |

**安全边界共识**：进程内 JS 插件不是硬安全边界，v1 以「manifest 权限声明 + 能力校验 + 首次授权弹窗」做策略层；桥接 API 面向未来设计，后续可平滑切换到 Web Worker 宿主实现真隔离。为此插件不得直接操作 DOM/画布，widget 一律运行在各自的 Shadow DOM 容器内。

## 架构速览

- **WebView 侧**：宠物渲染状态机（动画优先级队列）；Widget 宿主（每插件一个 Shadow DOM 插槽）；插件运行时（manifest 扫描 → 动态 import → activate/deactivate 生命周期，单插件错误隔离）；事件总线（topic 格式 `plugin-id:topic`）；PetAPI 能力桥（按 manifest 权限逐项校验，拒绝默认）。
- **Rust 宿主侧**：窗口管理（透明/置顶/点击穿透/拖拽）、托盘、单实例、自启；原生能力服务 ble / store（插件隔离 JSON 存储）/ http（白名单域名代理）/ notify；权限管理（授权记录 + 同意对话框）。

## 实施步骤（按序）

1. **脚手架 + 宠物窗**：Tauri 2 + Vite/TS 初始化；透明置顶窗、无边框拖拽、右键托盘、单实例；Canvas 占位宠物 + 状态机跑通 idle/walk。
2. **插件运行时**：manifest 解析校验、动态 import、生命周期、错误隔离、事件总线、widget Shadow DOM 宿主、插件隔离存储、设置窗（启停 + 权限列表）。
3. **Rust 能力服务**：store、http 白名单代理、notify、btleplug BLE 服务 + IPC 命令与事件转发、权限同意框。
4. **三个示例插件**：`todo`（完整可用）、`heart-rate-ble`、`llm-token-usage`。
5. **文档收尾**：PLUGIN_SDK.md（能力清单表、示例代码、调试方法），`npm run tauri dev` 全流程验证。

## 验收标准

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用
- plugins/ 目录放入/移除插件后，经设置窗启用停用生效；单插件异常不崩溃宿主
- todo 插件完整可用；心率插件能列出扫描到的 BLE 设备广播（有设备则显示实时 BPM）；token 插件按配置轮询并在 widget 显示
- 未授权能力调用被拒绝且触发同意框；SDK 文档完整到第三方可照写插件

## 约定

- 标准事件 topic：`ble:heart-rate`、`llm:token-usage`、`todo:changed`
- 插件存储位置：`%APPDATA%/DesktopPet/plugins/<id>`（插件间隔离，设置窗可撤销授权）
- 首批插件目录：`plugins/todo`、`plugins/heart-rate-ble`、`plugins/llm-token-usage`
