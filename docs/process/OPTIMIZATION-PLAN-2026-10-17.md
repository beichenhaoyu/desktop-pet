# 优化方案 2026-10-17：P1 安全面 + P2 可靠性

> 来源：2026-10-17 对全仓的一次通读评审（结论见本文 §1）。落地方式经用户确认：**由本次会话直接改代码**，
> 范围 **P1 + P2**；不含大重构（widget 虚拟 DOM 协议重写、BLE 持锁 await、同步命令阻塞主线程）。
>
> 分支：`fix/p1p2-security-reliability`（从 `main` 的 `3df68eb` 切出）。

## 1. 评审结论（本轮改动的依据）

被认定为真问题的条目，按严重度：

| 编号 | 问题 | 位置 |
|---|---|---|
| P1-1 | 门禁粒度是**窗口**而非**身份**：`gate::settings` 只看 `window.label()`，而插件设置页渲染在设置窗里。默认它跑在 Worker 中因此够不着，但逃生门 `host:widget-realm-plugin-host` 一旦点名某个插件，其设置页即回到设置窗 realm，**继承宿主级权限**（撤销他人授权、改自启/快捷键/形象、停用插件） | `src-tauri/src/gate.rs`、`src/runtime/widget-host.ts` |
| P1-2 | 同意框显示的**插件名由前端传入**，Rust 不回读磁盘 manifest，可被伪造——与「同意即安全边界」自相矛盾 | `src-tauri/src/services/permission.rs`、`src/runtime/bridge.ts` |
| P1-3 | topic ACL **只防发布、不防订阅**：只要声明 `bus:subscribe` 就能订任意他插件命名空间的 topic（含其 `:widget` 展示数据） | `src/runtime/topic-acl.ts` |
| P1-4 | `set_click_through` 是唯一**完全无门禁**的命令，且 `let _ =` 吞错——「全项目一把门禁」的说法不成立 | `src-tauri/src/window/pet.rs` |
| P2-4 | widget boot **无超时**（同族的 `worker-plugin-host` 有 60s）：Worker 崩或 import 悬挂时 mount 永久挂起，`mounting` / 会话表泄漏，unmount 卡死 | `src/runtime/worker-widget-host.ts` |
| P2-5 | 测试可信度：`Worker 侧不得带进裸 IPC` 这条**安全判据**是只认双引号的正则，改成单引号 import 即绕过；且只看直接 import，不看传递闭包 | `tests/unit/unit-worker-host.mjs`、`tests/unit/unit-widget-protocol.mjs` |
| P2-6 | `store` 的 per-plugin 锁表按 plugin_id **无界增长**，插件卸载后条目永不回收 | `src-tauri/src/services/store.rs` |
| P2-7 | `ARCHITECTURE.md` 首行残留一行目录树碎片；订阅语义的文档口径随 P1-3 需同步 | `docs/architecture/ARCHITECTURE.md` 等 |

## 2. 逐项方案

### P1-2 同意框身份回读磁盘 manifest

- `commands/plugins.rs` 新增 `manifest_display_name(app, plugin_id)`：读磁盘 manifest 的 `name`，
  缺失或非字符串时退回 `id`（与 `declared_capabilities` 同一份 `read_manifest` 出口）。
- `permission_request` **删掉 `plugin_name` 形参**，改由上述函数解析；`ask_user` 同步收窄。
  「未声明就不许申请」的校验顺序不变（先查 declared，再取名字）。
- 前端 `bridge.ts` / `plugin-runtime.ts` 停止传 `pluginName`；e2e 调用点同步删字段。
- **不变量**：同意框显示的名字只可能来自磁盘 manifest，前端给什么都无影响。

### P1-3 topic 订阅侧 ACL

- `packages/sdk/topics.js` 新增并导出 **`PUBLIC_TOPICS`**（冻结数组）= `STANDARD_TOPICS` ∪
  `{ble:device-found, ble:disconnected, ble:error}`，即「插件可跨命名空间订阅的公开 topic」；
  `topics.d.ts` 补伴生声明。这是唯一的定义处，宿主运行时从这里读。
- `topic-acl.ts::assertSubscribable` 收紧为：**自己前缀**放行；否则 topic 必须**精确命中**
  `PUBLIC_TOPICS`（仍要 `bus:subscribe`），通配一律拒。他人插件的私有 topic（如
  `com.pet.astock:widget`）从「有 bus:subscribe 就放行」变成**一律拒**。
- 这一改**不改**发布侧规则，也不动产线插件：四个插件订阅的非自己 topic 只有
  `agent:state` / `agent:event` / `ble:heart-rate` / `ble:device-found` / `ble:disconnected`，均在名单内。

### P1-4 点击穿透补门禁

`pet.rs::set_click_through` 加 `crate::gate::pet(&window, "切换点击穿透")?`，返回 `Result<(), HostError>`，
不再 `let _ =` 吞错。唯一调用点是宠物窗自己的 `src/pet/click-through.ts`，行为不变。

### P2-4 widget boot 超时

`worker-widget-host.mount` 给 `await booted` 套 `WIDGET_BOOT_TIMEOUT_MS = 15_000` 的定时器：
到点用 `settleBoot` 拒绝（与 `onerror` / `boot-failed` 同一条出口），随后 `destroy` 终止 Worker。
与 `worker-plugin-host` 的 60s 口径对齐（widget 只需跑 `mount()`，不需要等同意框，故收短）。

### P2-5 裸 IPC 判据换成真执行

新增 `tests/unit/import-graph.mjs`：用 TypeScript 编译器 API 解析每个模块的
import/export/动态 import 说明符（**与引号风格无关**），递归相对导入（`./x` → `x` → `x.ts` → `x/index.ts`），
产出「传递闭包 + 命中的 `@tauri-apps` / `host-error` 外部依赖」。两个套件改用它断言：
Worker 侧入口（`plugin-worker.ts` / `widget-worker.ts`）的**整个可达闭包**都不得触及 `@tauri-apps` 与 `host-error`。
原来那条「只认双引号、只看直接 import」的正则判据删掉。

### P2-6 store 锁表回收

`locks()` 的表体从 `Arc<Mutex<()>>` 改成 `Weak<Mutex<()>>`：取锁时 upgrade，失败就新建；
insert 时顺手清理已死的条目。插件被卸载后其锁对象随最后一个持有者一起释放，条目在下一次
任意取锁时被清走 —— 表大小回到"当前活着的插件数"量级。

### P2-7 文档

- `ARCHITECTURE.md` 删首行残留碎片。
- `PLUGIN_SDK.md` §4「topic 命名空间规则」、`CONVENTIONS.md`「topic 归属」按 P1-3 的新口径重写。
- `AGENTS.md` 在安全边界段补一句：**settings 区仍是例外名单唯一可达宿主 realm 的地方，本条已知未收口**。
- 新增 `docs/adr/0011-consent-identity-and-subscribe-acl.md` 记录本轮三项决定与理由。
- `HOST-BACKLOG.md` 状态板加一行（卡 `S2`），并加 P1-1 的待排卡。

## 3. 验收口径

**离线必绿（本会话内可跑）**

| 门 | 命令 | 期望 |
|---|---|---|
| 前端单测 | `npm run unit` | 全绿，且新增断言 > 0（P1-3 / P2-5） |
| 类型与构建 | `npm run build` | 退出码 0 |
| lint | `npm run lint` | 退出码 0 |
| 文档门禁 | `npm run check:docs` | `RESULT rules=8 failing=0` |
| 命令体形状 | `npm run check:shape` | `RESULT ... failing=0`（P1-4 改动不得撑破 20 行上限） |
| Rust | `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test` | 退出码 0；`gate_coverage` 与 `permission.tests` 的签名钉同步更新 |

**本会话无法取证（如实标注，不进本轮结论）**

- e2e（`verify` / `verify:worker` / `verify-release` / `verify:agent` / `verify:todo`）需要真实桌面会话 +
  CDP 9223 + 冷启动实例，本轮**未跑**。受影响的断言已按其现有口径核对过应当仍成立
  （P1-2 的同意框名用例断的是 fixture 的 manifest 名；P1-3 的现场 topic 全在公开名单内），
  但**「核对过」不等于「跑过」**，需在桌面会话上复跑一次。
- `cargo` 三件套若本机工具链不可用，同样如实标注。

## 4. 明确不做（本轮的边界）

| 项 | 为什么不在本轮 |
|---|---|
| **P1-1 settings 区强制进 Worker** | 见下节：会打穿 `verify-isolation` 的 agent:hooks 探针组，而该组只能靠桌面 CDP 会话取证；盲改等于留下一套断言过时的"假绿"。已拆成待排卡 |
| widget 虚拟 DOM 协议重写 | 大重构，收益/风险比不明确，用户已排除 |
| bus_publish 每次全量扫盘、sync store 命令持 std Mutex 做阻塞 IO | 性能面，量级上不构成当前痛感，留待有实测数据再动 |
| BLE 持 `core` 锁 await WinRT | 同上，需要真机 BLE 设备才能证明影响 |
| 同意框 `plugin_name` 之外的身份面（consent 窗口 label 可预测等） | 未发现可利用点，避免无证据的改动 |

## 5. 拆出去的卡：P1-1（settings 区强制进 Worker）

**为什么单独拆**

- 改法本身很小：`widget-host.doMount` 在 `region === "settings"` 时忽略例外名单，一律走 Worker。
- 但 `verify-isolation.mjs` 的「agent:hooks 受控能力（settings 区专属）」整组，靠
  `localStorage` 把 `zz.probe` 点名留在宿主 realm，探针要把事实写进 `window.__hookProbes` ——
  它的 manifest **没写 `apiVersion`**（= 旧接口）。按新规则该探针在 settings 区会被判 legacy →
  `mountNotice` 拦下 → 该组 12+ 条断言当场变红。
- 探针**按设计**必须在宿主 realm 才能自证（它读 `window`），所以这不是"改个 flag"能绕过的，
  得把这组断言改成走 Worker 契约（`ctx.dom` 建节点 + 自己 `bus.publish` 回传事实），
  或者把它挪到 `badge` 区并另想办法验 settings 区。**两种改法都要在真机上跑 CDP 套件才算数。**
- 本会话没有桌面会话（且 CONVENTIONS 明写 CDP 套件不能在热改实例上跑），所以拆出去。

**卡的边界（交给下一次有桌面会话的批次）**

- 只准动：`src/runtime/widget-host.ts`、`src/runtime/widget-protocol.ts`、`tests/e2e/verify-isolation.mjs`、
  `tests/e2e/verify-release.mjs`、`tests/unit/unit-widget-protocol.mjs`、相关文档。
- 已定口径：settings 区一律 Worker，例外名单只对 `badge` / `overlay` 区生效；
  旧接口 widget 在 settings 区的正确表现是**被拦下并给出可读原因**（`mountNotice`），不是"留在宿主 realm 跑起来"。
- 验收：`npm run unit` 全绿（新增"settings 区忽略例外名单"的纯逻辑钉）；桌面会话上
  `verify-isolation` / `verify-release` 冷启动复跑全绿，且探针组按新契约重写后仍覆盖
  「settings 区拿得到 ctx.host.agentHooks、其他区拿不到」这条不变量。

## 6. 与既有 ADR 的关系

- **ADR-0006 / ADR-0008**（插件与 widget 进 Worker）：本轮 P2-5 的传递闭包判据正是它们的守门人，
  属于加固而非改路线。P1-1 待排卡才是这两条的下一段。
- **ADR-0007**（统一错误码）：P1-4 的 `set_click_through` 改返回 `HostError`，与之一致。
- 本轮三项决定（同意框身份、订阅 ACL、点击穿透门禁）记入 **ADR-0011**。
