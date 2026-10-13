│   │   ├── CONVENTIONS.md      # 约定与验收明细（AGENTS.md 瘦身后的细节落点）
# 架构设计 — Windows 桌面宠物插件化框架

> 本文是技术选型任务的最终方案全文，迁移至本项目作为开发基准。设计经作者确认的四项决策见文末「决策记录」。原始讨论留存在原会话（sess_86051e96，2026-09-06）。

## 一、目标与范围

搭建一个**插件驱动**的 Windows 桌面宠物框架（当前阶段只做框架 + 示例插件）：

- 宠物本体：透明置顶窗口 + 2D 序列帧动画（Petdex 图集，九状态）+ 状态机
- 一切功能由插件提供，首批三个示例：心率蓝牙广播、大模型 token 用量、待办事项
- 面向第三方开放：manifest + 权限声明 + 能力受控 API + SDK 文档

## 二、技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 宿主框架 | Tauri 2（Rust） | 体积小、原生窗口/托盘能力完整 |
| 前端 | TypeScript + Vite（不引入重框架） | 宠物 Canvas 渲染 + 插件 widget 用 Shadow DOM 宿主，vanilla 即可 |
| 宠物形象/渲染 | Canvas2D 序列帧 + 状态机，图集来自 Petdex 公开画廊（运行时下载） | 无需 PixiJS；九状态词表与图集规格照搬 petdex，仓库不内置美术，只在图集不可用时退回程序生成的 idle 帧 |
| BLE | Rust `btleplug`（WinRT 后端） | 支持广播监听 + GATT 连接，覆盖"心率蓝牙广播"两种模式 |
| 插件形态 | WebView 内 ES Module（进程内） | 第三方门槛最低；Rust 动态库无稳定 ABI，不适合开放生态 |

**插件信任模型（如实声明）**：进程内 JS 插件不是硬安全边界。v1 用「manifest 权限声明 + 能力受控桥 + 首次授权弹窗」做策略层；桥接 API 面向未来设计，后续可平滑切换到 Web Worker 宿主实现真隔离（插件除 widget 容器外不直接碰 DOM，为此预留）。

## 三、架构总览

```
┌────────────────────────── WebView (前端) ──────────────────────────┐
│  宠物渲染层 (Canvas 状态机: petdex 九状态 + 动画优先级队列)            │
│  Widget 宿主 (气泡/面板插槽, 每插件一个 Shadow DOM 容器)             │
│  插件运行时: manifest 扫描 → 动态 import → 生命周期管理              │
│  事件总线 (命名空间 topic: "plugin-id:topic")                       │
│  PetAPI 能力桥 (按 manifest 权限逐项校验, 拒绝默认)                  │
└──────────────────────────── Tauri IPC ─────────────────────────────┘
┌────────────────────────── Rust 宿主 (src-tauri) ───────────────────┐
│  窗口管理 (透明/置顶/点击穿透/拖拽)  托盘  单实例  自启               │
│  原生能力服务:                                                      │
│   · ble      btleplug 广播监听 (ManufacturerData) + GATT 0x180D/2A37│
│   · store    插件隔离存储 (%APPDATA%/com.desktoppet.pet/plugins/<id>) │
│   · http     受控 HTTP 代理 (白名单域名, 避免 CORS/暴露密钥)         │
│   · notify   系统通知                                               │
│   · skins    Petdex 图集解析下载 + petskin:// 协议                   │
│  权限管理 (授权记录 + 同意对话框)                                    │
└────────────────────────────────────────────────────────────────────┘
```

## 四、目录结构

```
（仓库根目录，即本项目根）
├── src-tauri/                  # Tauri 2 宿主（Rust）：窗口/托盘/单实例/自启 + 原生能力服务
│   ├── src/
│   │   ├── lib.rs              # 应用装配：命令注册、托盘、建窗、setup 钩子
│   │   ├── main.rs             # 二进制入口（release 下不弹控制台）
│   │   ├── gate.rs             # 窗口来源门禁：命令按发起窗口判定能不能改宿主
│   │   ├── gate_coverage.rs    # 门禁覆盖面自检：按已注册命令反查谁没过闸
│   │   ├── ids.rs              # 插件 id 的唯一校验实现（同一个 id 又是存储目录名）
│   │   ├── fsutil.rs           # 落盘公共工具：tmp+pid+rename 原子写
│   │   ├── plugin_caps.rs      # 能力名单的宿主侧入口（与前端读同一份 json）
│   │   ├── commands/           # IPC 命令面，按域分文件
│   │   │   ├── plugins.rs      # 插件清单/启停/撤销授权 + 形象与 overlay 命令
│   │   │   ├── bus.rs          # bus_publish：origin 由宿主按发起窗口判定
│   │   │   └── agent.rs        # Agent hook 的状态/安装/卸载
│   │   ├── services/           # 原生能力服务：12 个功能模块
│   │   │   ├── ble.rs          # btleplug 广播监听 + GATT 0x180D/2A37 心率
│   │   │   ├── store.rs        # 插件隔离存储（%APPDATA%/com.desktoppet.pet/plugins/<id>）
│   │   │   ├── http.rs         # 白名单域名的受控 HTTP 代理
│   │   │   ├── notify.rs       # 系统通知（同样过授权表）
│   │   │   ├── permission.rs   # 授权记录 + 首次调用的同意对话框
│   │   │   ├── enabled.rs      # 插件启停清单（宿主磁盘上的唯一事实来源）
│   │   │   ├── autostart.rs    # 开机自启（官方插件读写 HKCU 的 Run 键）
│   │   │   ├── hotkeys.rs      # 全局快捷键唤出插件页
│   │   │   ├── fullscreen.rs   # 前台全屏探测（游戏模式的传感部分）
│   │   │   ├── agent_hooks.rs  # Qoder hook 配置的安装与卸载
│   │   │   ├── agent/          # hook 收件目录、事件归一化与会话状态机
│   │   │   └── skins/          # Petdex 图集下载/解析/磁盘布局 + petskin:// 协议
│   │   └── window/             # 窗口层
│   │       ├── pet.rs          # 宠物窗：透明/置顶/拖拽/点击穿透
│   │       ├── overlay.rs      # 悬浮窗：按插件各开一扇（标签 overlay-<id>）
│   │       └── tray.rs         # 托盘菜单
│   └── tauri.conf.json         # 窗口、权限与插件配置
├── src/                        # WebView 前端（TypeScript + Vite，不引重框架）
│   ├── index.html              # 宠物窗入口
│   ├── settings.html           # 设置窗入口
│   ├── overlay.html            # 插件悬浮窗入口
│   ├── consent.html            # 权限同意框入口
│   ├── main.ts                 # 宠物窗启动：状态机 + 序列帧播放器 + 渲染循环
│   ├── boot-error.ts           # 启动期兜底错误条（独立模块，CSP 不许内联脚本）
│   ├── styles.css              # 页面通用样式
│   ├── vite-env.d.ts           # Vite 类型声明
│   ├── pet/                    # 宠物本体：图集切片与九状态规格 + 播放器 + 状态机 + 皮肤解析 + 点击穿透/台词/游戏模式
│   ├── runtime/                # 插件运行时：发现与启停 + 能力桥 + 事件总线与 topic 归属 + widget 宿主
│   ├── settings/               # 设置窗：侧栏导航 + 插件页壳 + 形象/快捷键/自启/游戏模式分节
│   ├── overlay/                # 悬浮窗页：每扇只挂自己那个插件的 overlay widget
│   └── consent/                # 同意框页：展示插件身份与申请的能力
├── public/                     # Vite 静态目录：boot-error.css 原样进 dist 根（index.html 按 /boot-error.css 引用）
├── plugins/                    # 运行时插件目录（每个：manifest.json + index.js，磁盘加载）
│   ├── com.pet.hr-ble/         # 心率蓝牙广播：扫描/连接/实时 BPM
│   ├── com.pet.agent-bridge/   # Agent 桥：订阅宿主 agent:state 转成宠物反应
│   ├── com.pet.todo/           # 待办事项：增删改勾 + 桌面卡片 + 到期提醒
│   ├── com.pet.astock/         # A股盯盘：自选/提醒/badge/overlay + 分时/K线/五档
│   └── # 暂缓：llm-token-usage/ 目录未创建（用户 2026-10-10 决定，勿按存在处理）
├── packages/
│   └── sdk/                    # 插件 SDK：类型声明 + schema + 名单，全部是单一事实源
│       ├── index.d.ts          # 插件 ctx / PetAPI 的类型声明
│       ├── topics.d.ts         # 标准 topic 的类型声明
│       ├── topics.js           # 运行时 topic 常量
│       ├── manifest.schema.json      # 插件 manifest 的 JSON Schema
│       └── plugin-capabilities.json  # 能力名单（Rust 侧与 TS 侧共读同一份）
├── tests/
│   ├── unit/                   # node:test 单测（运行时、能力、manifest schema、行情源等）
│   └── e2e/                    # verify-*.mjs 端到端断言 + harness/（CDP 与夹具）
├── tools/                      # dev-debug.mjs（供断言脚本连 CDP）、generate-app-icon.ps1
├── docs/
│   ├── architecture/
│   │   └── ARCHITECTURE.md     # 本架构文档
│   ├── plugin-dev/
│   │   ├── PLUGIN_SDK.md       # 插件开发指南：manifest、能力表、示例
│   │   ├── PLUGIN-HANDBOOK.md  # 接活者的交付标准与坑清单
│   │   ├── PLUGIN-REVIEW.md    # 插件评审口径
│   │   └── PLUGIN-BACKLOG.md   # 插件域任务卡、派单模板、已否决项
│   ├── process/
│   │   ├── CODE-REVIEW.md      # 本体评审意见与结论
│   │   └── HOST-BACKLOG.md     # 本体/构建/文档域任务卡与验收证据矩阵
│   ├── adr/
│   │   ├── 0001-agent-hooks-capability-in-plugin-page.md
│   │   ├── 0002-single-agent-linkage-uninstall-then-install.md
│   │   ├── 0003-session-visibility-on-pet-bubble.md
│   │   ├── 0004-style-src-unsafe-inline-kept.md  # 插件样式注入契约为何暂不收紧
│   │   └── 0005-command-layering-thin-command-bodies.md  # 命令留在能力域、命令体收成薄层
│   └── desktop-pet-优化任务清单.docx   # 外部优化任务清单
├── assets/
│   └── app-icon.png            # 图标母版（generate-app-icon.ps1 的产物）
├── .github/
│   └── workflows/ci.yml        # CI：lint + 单测
├── release-package/            # 便携包产物（exe + 旁边的 plugins/ + 更新说明），不进版本库
├── AGENTS.md                   # 项目状态、决策与协作约定（主入口）
├── CONTEXT.md                  # 上下文速览
├── README.md
├── package.json
├── tsconfig.json               # 主工程 tsconfig
├── tsconfig.plugins.json       # 插件侧 checkJs 用
├── vite.config.ts
└── biome.jsonc                 # 格式化/lint 配置

# 约定：目录内的 mod.rs 与 *.tests.rs 不进本树（模块装配与内联单测，不是独立模块）。
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
    ctx.pet.react('jumping');   // 参数只能是 petdex 九状态之一（心率飙升时）
  },
  async deactivate() { /* 释放订阅/连接 */ }
}
```

**3. 事件总线**：所有跨插件通信走总线；Rust 原生事件（BLE 数据等）由宿主桥接注入。标准 topic：`ble:heart-rate`、`llm:token-usage`、`com.pet.todo:changed`。

**4. Widget 贡献**：插件注册 widget 到宿主插槽（宠物旁气泡/侧面板），运行在各自 Shadow DOM 中，宿主控制布局与样式隔离；托盘菜单项为另一贡献点。

**5. 动画引擎**：序列帧播放器 + 有限状态机，状态词表完全照搬 petdex 的九个状态（行号/帧数/时长见「8. 桌宠形象」），按优先级打断、同级或更低排队（上限 3）。交互语义：摸头→`waving`、戳肚子→`jumping`、拉尾巴→`failed` 并附加抖动；手势类（waving/jumping/failed）播完一遍整行时长回 idle；循环类（`running`/`review`/`running-left|right`）可被重复请求续期，安静 45 秒后自然回落 idle；长时间无交互（180 秒）进入 `waiting`（取代原来的「睡觉」位），任何交互即唤醒。插件只能通过 `pet:react` 请求这九个状态之一（其余名字被能力桥拒绝），不能直接操作画布。Agent 桥的 phase→状态映射也照搬 petdex：`pre`→`running`（只读工具 Read/Grep/Glob →`review`）、`tool-failure`/`stop-failure`→`failed`、`stop`→`waving`、`user-prompt`/`session-start`→`jumping`、`approval-request`/`notification`→`waiting`；会话仍在进行时 `post` 不把姿势打回 `idle`。

**6. 心率 BLE 服务**：`btleplug` 双模式——

- a) 广播监听（AdvertisementWatcher 收 ManufacturerData，不建链）；
- b) 标准 Heart Rate Service (0x180D) GATT 连接订阅 0x2A37 通知，解析 uint8/uint16 BPM。

若 btleplug 在 Windows 上广播数据受限，回退直接用 `windows` crate 的 BluetoothLEAdvertisementWatcher。

**7. 权限流**：插件首次调用未授权能力 → 宿主弹同意框（显示插件 id/名称/能力）→ 记录到 %APPDATA% 授权表，设置窗可撤销。

**8. 桌宠形象（Petdex 图集）**：仓库不内置任何美术文件，形象全部来自 Petdex 公开画廊；本项目定位是学习与自娱自乐、非商用，宿主按用户输入的名字在运行时下载，不内嵌、不再分发——

- a) 设置窗输入 Petdex 名字（如 `deepseek`）→ Rust `services/skins.rs` 走公开接口 `https://petdex.dev/api/manifest/v2` 解析 slug（响应里 `pets` 是数组的数组，列序由同响应的 `fields` 给出）；
- b) 下载 `sprite.webp` 到 `%APPDATA%/com.desktoppet.pet/skins/<slug>/`，经宿主自定义协议 `petskin://<slug>/sprite.webp`（Windows 上即 `http://petskin.localhost/…`）读给 webview——与插件文件的 `petplugin://` 同一条路，dev 与打包版共用同一个磁盘解析点；打包版 CSP 的 `img-src` 要含 `http://petskin.localhost`；
- c) 当前形象记在 `skins/active.json`，切换后宿主广播 `pet:skin-changed`，宠物窗不重启就换装；首次启动且本地没有皮肤时自动安装默认形象 `deepseek`，图集不可用时才退回程序生成的 idle 帧。

图集规格：8 列 × 9 行（v1，1536×1872）或 8 列 × 11 行（v2，1536×2288，多出的两行是预留空白）的无损 webp，单元格 192×208，行号即状态——row0 `idle`(6 帧/1100ms)、row1 `running-right`(8/1060)、row2 `running-left`(8/1060)、row3 `waving`(4/700)、row4 `jumping`(5/840)、row5 `failed`(8/1220)、row6 `waiting`(6/1010)、row7 `running`(6/820)、row8 `review`(6/1030)，规格定义在 `src/pet/petdex-states.ts`。

## 六、实施步骤

1. **脚手架 + 宠物窗**：Tauri 2 + Vite/TS 初始化；透明置顶窗、无边框拖拽、右键托盘、单实例；Canvas 播放 Petdex 图集序列帧，状态机跑通九个状态（图集不可用时退回程序生成的 idle 帧）。
2. **插件运行时**：manifest 解析与校验、动态 import、activate/deactivate 生命周期、错误隔离（单个插件抛错不影响宿主）、事件总线、widget Shadow DOM 宿主、插件隔离存储、设置窗（启停 + 权限列表）。
3. **Rust 能力服务**：store、http 代理（域名白名单）、notify、btleplug BLE 服务 + IPC 命令与事件转发、权限同意框、skins（图集解析下载 + `petskin://` 协议）。
4. **三个示例插件**：
   - `com.pet.todo`（完整可用）：增删改查 + widget 展示 + `com.pet.todo:changed` 广播
   - `heart-rate-ble`：扫描展示（无设备时显示广播列表）、连接后 widget 显示实时 BPM
   - `llm-token-usage`：配置 base URL/key（存宿主 store），轮询用量接口，widget 显示当日 token 消耗
5. **文档与收尾**：ARCHITECTURE.md（本文）、docs/plugin-dev/PLUGIN_SDK.md（能力清单表、示例代码、调试方法）、`npm run tauri dev` 验证全流程。

## 七、验收标准

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用
- 设置窗输入 Petdex 名字（如 `deepseek`）即从公开画廊下载并换装，宠物窗不必重启；本地无皮肤的首次启动自动装默认形象 `deepseek`
- plugins/ 目录放入/移除插件目录后，经设置窗启用停用生效，单插件异常不崩溃宿主
- com.pet.todo 插件完整可用；心率插件能列出扫描到的 BLE 设备广播（有设备则显示 BPM）；token 插件按配置轮询并在 widget 显示
- 未授权能力调用被拒绝且触发同意框；SDK 文档完整到第三方可照写插件

## 决策记录

原规划任务中已与作者确认的四个决策：

| 决策点 | 结论 | 未选路线（备忘） |
|---|---|---|
| 技术栈 | Tauri 2（Rust + WebView） | C# .NET 8 + WPF（BLE/窗口集成最好但生态封闭）、Python + PySide6（迭代快但打包 80MB+）、Electron（内存 150MB+） |
| 插件隔离 | 进程内加载（WebView 内 ES Module） | 独立进程沙箱（开发量翻倍）、混合模式（v2 预留接口） |
| 宠物形象 | Petdex 公开画廊的九状态图集（2D 序列帧，运行时按名字下载，仓库不内置美术） | Live2D（SDK 授权费用 + 模型资源成本）、自绘美术内嵌分发（非商用学习项目，没必要背美术资产） |
| 插件生态 | 开放第三方生态（权限声明 + 能力桥） | 仅自研/团队插件 |

补充：选 Tauri + WebView 内 JS 插件的关键理由——Rust 动态库没有稳定 ABI，不适合开放第三方；WebView 内 ES Module 是第三方门槛最低的插件形态（VSCode 式模型），原生能力（BLE 等）由宿主 Rust 服务提供、经能力受控的桥接 API 开放。
