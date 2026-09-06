# 架构设计 — Windows 桌面宠物插件化框架

> 本文是技术选型任务的最终方案全文，迁移至本项目作为开发基准。设计经作者确认的四项决策见文末「决策记录」。原始讨论留存在原会话（sess_86051e96，2026-09-06）。

## 一、目标与范围

搭建一个**插件驱动**的 Windows 桌面宠物框架（当前阶段只做框架 + 示例插件）：

- 宠物本体：透明置顶窗口 + 2D 序列帧动画 + 状态机
- 一切功能由插件提供，首批三个示例：心率蓝牙广播、大模型 token 用量、待办事项
- 面向第三方开放：manifest + 权限声明 + 能力受控 API + SDK 文档

## 二、技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 宿主框架 | Tauri 2（Rust） | 体积小、原生窗口/托盘能力完整 |
| 前端 | TypeScript + Vite（不引入重框架） | 宠物 Canvas 渲染 + 插件 widget 用 Shadow DOM 宿主，vanilla 即可 |
| 宠物渲染 | Canvas2D 序列帧 + 状态机 | 无需 PixiJS，先内置程序生成的占位帧 |
| BLE | Rust `btleplug`（WinRT 后端） | 支持广播监听 + GATT 连接，覆盖"心率蓝牙广播"两种模式 |
| 插件形态 | WebView 内 ES Module（进程内） | 第三方门槛最低；Rust 动态库无稳定 ABI，不适合开放生态 |

**插件信任模型（如实声明）**：进程内 JS 插件不是硬安全边界。v1 用「manifest 权限声明 + 能力受控桥 + 首次授权弹窗」做策略层；桥接 API 面向未来设计，后续可平滑切换到 Web Worker 宿主实现真隔离（插件除 widget 容器外不直接碰 DOM，为此预留）。

## 三、架构总览

```
┌────────────────────────── WebView (前端) ──────────────────────────┐
│  宠物渲染层 (Canvas 状态机: idle/walk/sleep/react + 动画优先级队列)   │
│  Widget 宿主 (气泡/面板插槽, 每插件一个 Shadow DOM 容器)             │
│  插件运行时: manifest 扫描 → 动态 import → 生命周期管理              │
│  事件总线 (命名空间 topic: "plugin-id:topic")                       │
│  PetAPI 能力桥 (按 manifest 权限逐项校验, 拒绝默认)                  │
└──────────────────────────── Tauri IPC ─────────────────────────────┘
┌────────────────────────── Rust 宿主 (src-tauri) ───────────────────┐
│  窗口管理 (透明/置顶/点击穿透/拖拽)  托盘  单实例  自启               │
│  原生能力服务:                                                      │
│   · ble      btleplug 广播监听 (ManufacturerData) + GATT 0x180D/2A37│
│   · store    插件隔离 JSON 存储 (%APPDATA%/DesktopPet/plugins/<id>) │
│   · http     受控 HTTP 代理 (白名单域名, 避免 CORS/暴露密钥)         │
│   · notify   系统通知                                               │
│  权限管理 (授权记录 + 同意对话框)                                    │
└────────────────────────────────────────────────────────────────────┘
```

## 四、目录结构

```
（仓库根目录，即本项目根）
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs / main.rs
│   │   ├── commands/        # IPC 命令: ble_*, store_*, http_proxy, notify
│   │   ├── services/{ble.rs, store.rs, http.rs, permission.rs}
│   │   └── window/{pet.rs, tray.rs}
│   └── tauri.conf.json      # 透明置顶窗配置
├── src/
│   ├── pet/                 # 序列帧播放器 + 状态机 + 事件触发动作
│   ├── runtime/
│   │   ├── plugin-runtime.ts   # 发现/加载/启停/卸载
│   │   ├── bridge.ts           # 面向插件的 PetAPI（能力校验在此）
│   │   ├── event-bus.ts
│   │   └── widget-host.ts      # Shadow DOM 插槽
│   ├── settings/            # 设置窗: 插件开关、权限管理
│   └── main.ts
├── plugins/                 # 运行时插件目录（每个: manifest.json + index.js）
│   ├── todo/
│   ├── heart-rate-ble/
│   └── llm-token-usage/
├── docs/
│   ├── ARCHITECTURE.md      # 本架构文档
│   └── PLUGIN_SDK.md        # 插件开发指南（实施阶段编写）
├── AGENTS.md
└── package.json
```

## 五、核心设计

**1. 插件 manifest（含权限声明，开放生态的基础）**

```json
{
  "id": "com.pet.hr-ble",
  "name": "心率蓝牙广播",
  "version": "0.1.0",
  "entry": "index.js",
  "permissions": ["ble:scan", "ble:connect", "bus:publish", "bus:subscribe",
                   "widget", "storage", "pet:react", "tray:menu"]
}
```

**2. 插件契约（SDK，@desktop-pet/sdk 类型包随文档提供）**

```ts
export default {
  manifest,
  async activate(ctx: PluginContext) {        // ctx 能力按 permissions 裁剪
    ctx.bus.subscribe('ble:heart-rate', e => ctx.widget.update(e));
    const stop = await ctx.ble.watchHeartRate({ mode: 'advertisement+gatt' });
    ctx.pet.react({ emotion: 'surprised', duration: 2000 });  // 心率飙升时
  },
  async deactivate() { /* 释放订阅/连接 */ }
}
```

**3. 事件总线**：所有跨插件通信走总线；Rust 原生事件（BLE 数据等）由宿主桥接注入。标准 topic：`ble:heart-rate`、`llm:token-usage`、`todo:changed`。

**4. Widget 贡献**：插件注册 widget 到宿主插槽（宠物旁气泡/侧面板），运行在各自 Shadow DOM 中，宿主控制布局与样式隔离；托盘菜单项为另一贡献点。

**5. 动画引擎**：序列帧播放器 + 有限状态机（idle/walk/sleep + react 插播队列，按优先级打断/恢复），插件只能通过 `pet:react` 能力触发动作，不能直接操作画布。

**6. 心率 BLE 服务**：`btleplug` 双模式——

- a) 广播监听（AdvertisementWatcher 收 ManufacturerData，不建链）；
- b) 标准 Heart Rate Service (0x180D) GATT 连接订阅 0x2A37 通知，解析 uint8/uint16 BPM。

若 btleplug 在 Windows 上广播数据受限，回退直接用 `windows` crate 的 BluetoothLEAdvertisementWatcher。

**7. 权限流**：插件首次调用未授权能力 → 宿主弹同意框（显示插件 id/名称/能力）→ 记录到 %APPDATA% 授权表，设置窗可撤销。

## 六、实施步骤

1. **脚手架 + 宠物窗**：Tauri 2 + Vite/TS 初始化；透明置顶窗、无边框拖拽、右键托盘、单实例；Canvas 占位宠物（程序生成圆形角色）+ 状态机跑通 idle/walk。
2. **插件运行时**：manifest 解析与校验、动态 import、activate/deactivate 生命周期、错误隔离（单个插件抛错不影响宿主）、事件总线、widget Shadow DOM 宿主、插件隔离存储、设置窗（启停 + 权限列表）。
3. **Rust 能力服务**：store、http 代理（域名白名单）、notify、btleplug BLE 服务 + IPC 命令与事件转发、权限同意框。
4. **三个示例插件**：
   - `todo`（完整可用）：增删改查 + widget 展示 + `todo:changed` 广播
   - `heart-rate-ble`：扫描展示（无设备时显示广播列表）、连接后 widget 显示实时 BPM
   - `llm-token-usage`：配置 base URL/key（存宿主 store），轮询用量接口，widget 显示当日 token 消耗
5. **文档与收尾**：ARCHITECTURE.md（本文）、PLUGIN_SDK.md（能力清单表、示例代码、调试方法）、`npm run tauri dev` 验证全流程。

## 七、验收标准

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用
- plugins/ 目录放入/移除插件目录后，经设置窗启用停用生效，单插件异常不崩溃宿主
- todo 插件完整可用；心率插件能列出扫描到的 BLE 设备广播（有设备则显示 BPM）；token 插件按配置轮询并在 widget 显示
- 未授权能力调用被拒绝且触发同意框；SDK 文档完整到第三方可照写插件

## 决策记录

原规划任务中已与作者确认的四个决策：

| 决策点 | 结论 | 未选路线（备忘） |
|---|---|---|
| 技术栈 | Tauri 2（Rust + WebView） | C# .NET 8 + WPF（BLE/窗口集成最好但生态封闭）、Python + PySide6（迭代快但打包 80MB+）、Electron（内存 150MB+） |
| 插件隔离 | 进程内加载（WebView 内 ES Module） | 独立进程沙箱（开发量翻倍）、混合模式（v2 预留接口） |
| 宠物形象 | 2D 序列帧动画 | Live2D（SDK 授权费用 + 模型资源成本）、纯占位 |
| 插件生态 | 开放第三方生态（权限声明 + 能力桥） | 仅自研/团队插件 |

补充：选 Tauri + WebView 内 JS 插件的关键理由——Rust 动态库没有稳定 ABI，不适合开放第三方；WebView 内 ES Module 是第三方门槛最低的插件形态（VSCode 式模型），原生能力（BLE 等）由宿主 Rust 服务提供、经能力受控的桥接 API 开放。
