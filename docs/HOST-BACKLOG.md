# 本体与工程任务池（派单 / 验收）

维护：项目经理（负责拆需求、派单、验收）。开发由外部敏捷模型接卡，本文件是接口。

插件域的卡片在 [PLUGIN-BACKLOG.md](PLUGIN-BACKLOG.md)（`A` 候选插件、`B` 需要宿主新能力的提案），
评审口径在 [PLUGIN-REVIEW.md](PLUGIN-REVIEW.md)，接活者的交付标准在 [PLUGIN-HANDBOOK.md](PLUGIN-HANDBOOK.md)。
**本文件只收非插件域**：本体（`src/`、`src-tauri/`）、构建与发布、文档与工程约定。

编号规则：本体功能/缺陷卡续用 `B`（下一张 `B2`）；工程与发布卡用 `S`。

## 0. 卡片模板（复制给接活的模型）

```
任务：<Bn|Sn> —— <一句话目标>
类型：本体缺陷 / 本体功能 / 工程发布 / 文档        ← 决定下面哪条边界生效
必读：AGENTS.md（技术决策表 + 约定，选型不许重议）、docs/ARCHITECTURE.md、
      docs/PLUGIN-HANDBOOK.md（若动到插件协议）、被点到的模块源码
边界：只准动这些文件 —— <逐个列出，白名单制>
      不得改 tauri.conf.json 的 CSP、不得加/删 Cargo 依赖（除非卡片明列）、
      不得动 plugins/ 下其他插件目录、不得 git push。
      需要越界就停下来提问，不要顺手改。
已定口径：<本卡依赖的既有决定与坑，摘自 AGENTS.md，标明「不要重新选型」>
方案约束：<已定的实现方向，防止接活者另起炉灶>
MVP 范围：<这一轮只做什么>
明确不做：<列出来，防止范围扩大>
验收：<逐条可观察标准 + 指名要跑哪个 verify 套件 + 该套件断言数不得低于 N 条>
交付：git 提交（不 push）、temp 清空、无遗留进程、验收套件的完整输出粘贴（含末尾汇总行与退出码）
```

## 1. 状态板

| 卡 | 标题 | 类型 | 状态 | 依赖 | 提交 | 评审 |
|---|---|---|---|---|---|---|
| S1 | 发布 0.2.0 便携包 | 工程发布 | **搁置**（用户 2026-10-11 定的口径：等 B2/B3/B4/A9 落地后一起出包，省一次重编与一轮 `verify:release`；版本号改动与文档提交同样压到那时） | — | — | — |
| B2 | `agent:hooks` 受控能力：钩子配置从设置窗移交到插件页 | 本体功能 + 安全边界 | 待排（可立即派） | — | — | — |
| B3 | 本体气泡常驻状态行 + 节点台词分层 | 本体功能 | 待排（可立即派，与 B2 并行） | — | — | — |
| B4 | Agent 适配器注册表 + 单联动事务（卸旧装新） | 本体功能 | 待排（可立即派，与 B2/B3 并行） | — | — | — |
| A9 | agent 桥改造：插件页承接配置 + 多 Agent 单选 + 去掉会话卡片 | 插件 | 待排，**等 B2/B3/B4 全部放行** | B2 B3 B4 | — | — |

状态词表沿用 PLUGIN-BACKLOG：`待排` / `已派` / `进行中` / `待评审` / `已放行` / `搁置`。
术语与决策见 [../CONTEXT.md](../CONTEXT.md) 与 [adr/0001](adr/0001-agent-hooks-capability-in-plugin-page.md)、
[adr/0002](adr/0002-single-agent-linkage-uninstall-then-install.md)、[adr/0003](adr/0003-session-visibility-on-pet-bubble.md)。

## 2. 卡片

### S1 发布 0.2.0 便携包 · 状态：**进行中**（规划方自己执行，不派单）

- **为什么在本池里**：发布不是开发任务，验收手段（跑构建、核对产物、验打包版 CSP）只有规划方有上下文。
- **产物口径（已定，别改）**：`release-package/DesktopPet-<版本>/` = `desktop-pet.exe` + 旁边的 `plugins/` + `更新说明.txt`，
  外加同名 zip。**不是 `dist/`** —— `dist/` 是 Vite 输出目录，任何 `npm run build` / `tauri build` 都会清空它，本项目已因此丢过两次成品包。
- **构建**：`npm run tauri build -- --no-bundle`（前端 tsc+vite 已过）。插件是磁盘加载，改 `plugins/` 不需要重编本体。
- **出包前必查**：`src-tauri/target/release/desktop-pet.exe` 的 mtime 必须**晚于** `src/` 与 `src-tauri/` 的最后一次提交，
  否则是过期二进制。S1 就撞上了：exe 是 2026-09-06 的 0.1.0，落后 4 天的代码。
- **发布门槛**：`npm run verify:release` 全绿（打包版 CSP 只在打包产物里强制，dev 不注入 CSP、测不出来；
  验 CSP 不能用 CDP/DevTools 发起的求值，那不受 CSP 约束，要看页面自身代码的副作用）。
  用户当次明确免跑时，`更新说明.txt` 里**不得声称本包已验**，改写成「回归在开发机完成 + 本包未复跑」。
- **本轮已知障碍（2026-10-10 实测）**：360 安全卫士会在 build script 刚写盘的一瞬间锁住
  `src-tauri/target/release/build/*/build-script-build.exe`，cargo 报 `拒绝访问。(os error 5) (never executed)`。
  文件没有被隔离 —— 手动执行同一个脚本立刻 0 退出。**结论：这是瞬时拦截，重试即可；不要删 `target/`，不要怀疑代码，不要动安全软件。**
  本机 Defender 实时防护是关闭的，360 是唯一拦截者。
- **收尾**：`git status` 复核提交里有无凭据；版本号四处一致（`package.json` / `package-lock.json` /
  `tauri.conf.json` / `Cargo.toml` + `Cargo.lock` 的 `desktop-pet` 条目）。

### B2 `agent:hooks` 受控能力 —— 钩子配置从设置窗移交到插件页 · 状态：**待排**

- **任务**：让插件自己的设置页能查询/安装/卸载 Agent hook；「宠物设置」里那张「Agent 事件接入」卡片整体删除。
- **任务类型**：本体功能 **+ 安全边界变更**（本项目第一次把能改别人应用配置的能力开给插件，先读
  [adr/0001](adr/0001-agent-hooks-capability-in-plugin-page.md)，验收按它核对，不要自己重新论证）。
- **必读**：[../CONTEXT.md](../CONTEXT.md)（「生命周期」四个动作的定义）、AGENTS.md「跨会话生效的系统级开关一律只认设置窗」那条约定、
  `src-tauri/src/gate.rs`（含头注释里的信任模型说明）、`src-tauri/src/commands/agent.rs`、
  `src-tauri/src/services/agent_hooks.rs:1-130`、`src/runtime/bridge.ts:42-95`（`ensurePermissions`/`gated`）、
  `src/runtime/widget-host.ts:86-90`（widget ctx 现在只有 `ScopedBus`）、`src/runtime/topic-acl.ts`。
- **实况纠偏（写死在这里，免得接活者重新猜一遍）**：插件 `settings` 区的 widget 是 `src/settings/main.ts` 里
  `widgetHost.mount(manifest, "settings", box)` 挂的，**跑在设置窗 realm**，所以 `gate.rs` 的 `label=="settings"`
  对它本来就成立；缺口只有一个 —— widget ctx 没有 invoke 通道。**不要为了"放行"去改门禁判定**，
  那既没必要，也会把注释里的信任模型一起改错。
- **边界（只准动这些，其余一律不碰）**：
  - `src-tauri/src/gate.rs`、`src-tauri/src/commands/agent.rs`、`src-tauri/src/lib.rs`（仅命令注册处）
  - `src/runtime/bridge.ts`、`src/runtime/widget-host.ts`、`src/runtime/topic-acl.ts`
  - `src/settings/main.ts`、`settings.html`
  - `PLUGIN_SDK.md`（§3 能力表加一行）、`AGENTS.md`（改那条约定的含义）
  - `scripts/verify-isolation.mjs`、`scripts/verify-agent-bridge.mjs`（只做断言迁移，不做功能改动）
  - **不得**动 `plugins/com.pet.agent-bridge/`（归 A9）、`src/main.ts` 与 `src/pet/`（归 B3）、`services/agent.rs` 的收件与归一化、
    `tauri.conf.json`、CSP。
- **方案约束（已定，别再选）**：
  1. 能力名 `agent:hooks`，必须 manifest 声明；首次调用走 `permission_request` 同意框（复用 `gated()`，不要另写一套授权模型）。
  2. 注入面**只在 `region === "settings"`**：给 widget ctx 加 `host.agentHooks.{status,install,uninstall}`；
     `badge` / `overlay` 区与宠物窗主 realm 的插件上下文**不注入**。这是本卡唯一的新攻击面，越窄越好。
  3. Rust 三个命令增加可选 `pluginId`：**不带** = 宿主自己的调用（撤销授权的确认框要用），照旧只过 `gate::settings`；
     **带** = 插件调用，额外逐项校验 `agent:hooks`。别把宿主路径也绑上 pluginId —— 那会让撤销流程依赖插件还活着。
  4. `commands/agent.rs:3-6` 的注释现在写着「权限比任何插件能力都高……插件即便绕过 JS 桥直接 invoke 也拿不到这个入口」，
     **必须改写**成 ADR-0001 的口径：挡的是别的窗口，不挡同 realm 的主动越权（那条缺口要等 Web Worker 宿主才收口）。
     留着旧注释就是给下一批人一个假安全感。
  5. `src/settings/main.ts:360-435` 的 `renderAgent/runAgentAction/wireAgentBox`、`:574-575` 的启动调用、
     `settings.html:83-96` 那张卡片，**一起删干净**，不留"以后可能还要"的死代码。
  6. 撤销授权的连带卸载确认框由**宿主**弹（撤销入口在宿主壳里，插件拦不到这一步）：默认勾选「同时卸载 hook」，
     用户可以只撤能力。选「连带卸载」时复用 uninstall 那条路径，不要另写一份删除逻辑。
- **MVP 范围**：上面 6 条 + 断言，做完就停。
- **明确不做**：多 Agent 注册表与切换事务（B4）、气泡显示（B3）、agent 桥插件侧任何改动（A9）、
  hook 写入格式与幂等策略的调整（`strip_managed`/`append_managed`/`backup_once`/原子写全部照旧）、
  自动安装 hook、动 `PET_AGENT_CONFIG_FILES` 这个开发覆盖入口的语义。
- **验收**（下限，**断言只许变严**）：
  - `cargo test --lib` ≥ **70**；新增：带 `pluginId` 且未声明 `agent:hooks` → install/uninstall 被拒；
    不带 `pluginId` 的宿主路径仍通；`overlay-*` 窗发来的调用被 `gate` 拒。
  - `npm run verify` ≥ **147**；新增：未声明能力的插件在 settings 区调用 → 被拒且弹同意框；声明并同意后 → 装得上、
    `status` 回显对得上；`badge`/`overlay` 区 ctx 上取不到 `host.agentHooks`（断言 `undefined`，**不是**断言"调用报错"）；
    宠物窗主 realm 里直接 `invoke("agent_hooks_install")` 被拒（label=pet）。
  - **`verify-agent-bridge.mjs:459-462` 那三条「插件调用被拒」断言不许整组删** —— 新模型下 settings 区调用是合法路径，
    要改写成「badge/overlay 区仍被拒 + settings 区经能力校验后才放行」这两条更强的断言；迁移后该文件总数不得少于 **50**。
  - **只删自家条目**（P0）：构造一份含他人 hook 条目的样例 `settings.json`，走完 install→uninstall 后断言
    `--pet-hook` 条目归零且**别人的条目逐字节未变**。
  - 撤销授权确认后两条分支都要有断言：「连带卸载」→ 配置文件干净；「只撤能力」→ 文件保持装好状态且能力缓存失效。
  - 动了 `settings.html` → 必须跑 `npm run verify:release` 且 ≥ **12** 全绿。
  - `git diff` 复核：出现 `src/main.ts`、`src/pet/`、`plugins/` 的改动就是越界，直接打回。
- **落地后回改（规划方做，接活者在提交说明里提醒即可）**：AGENTS.md 那条约定补上"指 realm、不指宿主独占"，
  `agent:hooks` 进能力名清单与 PLUGIN_SDK 表格，README 功能清单同步。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`cargo test` + `verify` + `verify:release` 尾部汇总与退出码粘贴、
  改后的 `commands/agent.rs` 头注释原文。

### B3 本体气泡 —— 常驻状态行与节点台词分层 · 状态：**待排**

- **任务**：气泡除了 3.6 秒自动收起的一次性台词，还要能挂一行**常驻**状态文字（随事件刷新、不定时消失）；
  常驻行存在期间宿主的随机自言自语让路。
- **任务类型**：本体功能。先看 [adr/0003](adr/0003-session-visibility-on-pet-bubble.md)，那里记了为什么不选"只播报节点"和"两行容器"。
- **必读**：`src/main.ts:15`、`:50-57`（`syncLayout` 写 CSS 变量）、`:61-67`（`say()`：`textContent` + 3600ms 收起）、
  `src/styles.css:43-84`（`max-width:var(--pet-size)` ≈ 立绘 266px、`::after` 尾巴、`pointer-events:none`）、
  `src/runtime/bridge.ts:160-174`（能力校验、压换行、截 200 字）、`src/pet/host.ts`、`src/pet/dialogue.ts:6-24`、
  `src/pet/click-through.ts:107-117`、`src-tauri/src/window/pet.rs:39-51`（`set_pet_hidden`）、`src/pet/game-mode.ts:33-44`。
- **边界**：`src/main.ts`、`src/pet/host.ts`、`src/pet/dialogue.ts`、`src/styles.css`、`src/runtime/bridge.ts`、
  `PLUGIN_SDK.md`、`scripts/verify-isolation.mjs`、`scripts/verify-agent-bridge.mjs`（只配合迁移断言，不改插件）。
  **不得**动 `plugins/`、`src-tauri/`（本卡预期零 Rust 改动）、`tauri.conf.json`、CSP、overlay 机制、状态机优先级队列。
- **方案约束（已定）**：
  1. 新增显式能力 **`pet:status`**，不复用 `say()` 的第二参数 —— "自动收起"是 `say` 的语义核心，
     塞 sticky 会让已有插件的行为漂移；权限也要能单独撤销。
  2. `setStatus(text)`：非空字符串 = 常驻并立即刷新；`null`/空串 = 清除。**按持有者唯一**：
     第二个插件来申请时拒绝并 `ctx.log` 写清谁在持有（口径对齐 BLE 会话的持有者计数），不许静默覆盖。
  3. 宿主必须在 **widget unmount / 插件 deactivate / 撤销授权** 三条路径上强制清除自己发出去的常驻行 ——
     不能指望插件自觉，否则会出现"插件已经没了、宠物头顶还挂着别人的会话状态"。
  4. 长度：常驻行截 **60 字**（`say` 现在是 200 字，但 266px 宽度下 200 字会撑成五行盖住立绘）；
     仍沿用「压掉换行 + `textContent`」，**不许**拼 HTML。
  5. 常驻行存在期间 `dialogue.ts` 的随机台词与 `wake` 自语**跳过本次**（不是排队到后面补播），常驻行清除后自然恢复。
  6. 节点台词与常驻行**分层**：台词收起不能顺带清掉常驻行。现在是一个 `#pet-bubble` 元素配一个 `.show` 类，
     实现上要么拆成两个元素、要么让常驻行独立于 `.show` 的生命周期 —— 验收只认断言，不认写法。
  7. 游戏模式：常驻行随宠物窗整体隐藏，恢复显示时若仍持有就**要重新出现**，不许"回来后发现没状态"。
- **明确不做**：不改气泡字号/配色/动画、不做两行容器、不做打字机效果、不给插件控制样式、
  不动 `react()` 的状态机优先级、不改 overlay 的 above-pet 跟随机制。
- **验收**（下限）：
  - `npm run verify` ≥ **147**，且 `4a7a05d` 新加的那 4 条气泡几何断言（居中、宽度不超立绘）继续全绿。
  - 常驻性：`setStatus` 后等 **>5 秒**（跨过 3600ms）文字仍在；`setStatus(null)` 后立即消失。
  - 分层：常驻期间调 `say()`，等台词自己收起后断言常驻行**未受影响**（这条是分层的唯一证据，不能省）。
  - 生命周期三条路径各一条：unmount / deactivate / 撤销授权之后气泡区域干净（断言 `textContent` 为空，不是"没报错"）。
  - 持有者唯一：第二个探针插件 `setStatus` 被拒，且第一个插件的常驻行**没被覆盖**。
  - 截断：喂 200 字 → 断言渲染出的文字 ≤60 字**且没有溢出宠物窗上沿**（读 `getBoundingClientRect`，别只看长度）。
  - 自语让路：触发一次 dialogue，断言常驻行存在期间台词没有写进气泡。
  - 穿透：常驻行显示期间，鼠标停在气泡区域仍判定 not-inside（沿用 `click-through.ts` 的断言形式）。
  - `npm run verify:game` ≥ **15** 全绿（动了显隐）；动了 `src/styles.css` → 跑 `npm run verify:release` ≥ **12**。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`verify` + `verify:game` 尾部汇总与退出码粘贴。

### B4 Agent 适配器注册表 + 单联动事务 · 状态：**待排**

- **任务**：把 `candidate_files` 里硬编的 `.qoder`/`.qoder-cn` 变成「一个 Agent 一个适配器」的注册表，
  提供一条事务式的"当前联动只有一个 Agent"切换命令；`qoder` 行为一字不变，`zcode`/`codex`/`dsh` 只留槽位。
- **任务类型**：本体功能。**范围是用户 2026-10-11 拍的**：本轮不许接线任何新 Agent，理由见
  [adr/0002](adr/0002-single-agent-linkage-uninstall-then-install.md) 和下面的实测现状 —— 猜出来的事件名映射比不做更糟。
- **规划方已实测的现状（接活者不要重复取证）**：

  | Agent | 本机现状 | 结论 |
  |---|---|---|
  | `qoder` | `~/.qoder/settings.json`、`~/.qoder-cn/settings.json` 存在；结构 `{hooks:{<Event>:[{hooks:[{type:"command",command,timeout:2}]}]}}`；12 个事件名 | **唯一已验证**，本轮行为必须一字不变 |
  | `zcode` | `~/.zcode` 存在；`cli/plugins/cache/**/hooks/hooks.json` 有 `hooks` 字段，但官方插件样本是空的 `{}` | 事件名与用户级入口**未知**，只留槽位 |
  | `codex` | `~/.codex/config.toml` 只有 `[tui]`、`[model_providers.*]`，**无任何 hook 键**；`executor.config.toml` 同 | 是否支持 hook **未证实**，只留槽位 |
  | `dsh` | `~/.dsh` 不存在，从仓库与代码里都推不出它指什么 | 用户口径：只留 id 槽位，不接线 |

- **必读**：`src-tauri/src/services/agent_hooks.rs`（`candidate_files:162-177`、`strip_managed:31`、`append_managed:68`、
  `install_in_text:118`、`uninstall_in_text:126`、`backup_once:179`、原子写 `:192-208`）、
  `src-tauri/src/services/agent.rs:34-47`（`HOOK_PHASES` 的 `(事件名, phase)` 形状）、
  `commands/agent.rs:27-40`（`snapshot`）、`../CONTEXT.md` 的「Agent 联动」与「生命周期」。
- **边界**：`src-tauri/src/services/agent_hooks.rs`、`services/agent.rs`（**只**许动事件名/适配器表，不许动 watcher 与归一化）、
  `commands/agent.rs`、`src-tauri/src/lib.rs`（命令注册）、`scripts/verify-agent-bridge.mjs`、
  `PLUGIN_SDK.md`（若把选择器暴露给插件）、`AGENTS.md` 的 Agent 接入约定（改文案不改语义）。
  **不得**动 `src/`（B3 地盘）、`plugins/`（A9 地盘）、`services/http.rs`、CSP。
- **方案约束（已定）**：
  1. 适配器形状至少含 `{ id, 显示名, 候选配置文件解析, 事件名→phase 映射, 命令串模板 }`；`qoder` 用现有常量填进去，
     **写入格式与幂等策略一字不改**（`--pet-hook` 标记、先 `strip` 后 `append`、`backup_once`、`.tmp`+rename 全部沿用）。
  2. 未验证的槽位**不得进入默认解析**：注册表里有 id，但没有已证实的解析规则时 install 必须直接返回
     「该 Agent 的接入方式尚未验证」，**不许去猜路径写文件** —— 写坏别人的配置按 P0 处理。
  3. 新增命令 **`agent_hooks_switch({ pluginId?, agentId })`**：事务 = 卸旧 → 校验卸净 → 装新 → 校验；
     任一步失败**回滚原状**并回传失败文件与原因。顺序不许反（先装新会让两个来源同时往同一个 inbox 写，
     而 `agent/inbox/<phase>.jsonl` 的事件**没有来源字段**，归一化层分不开）。
  4. **「当前联动哪个 Agent」由宿主持久化**（授权表旁边一份状态），不能只存插件隔离存储：
     插件崩溃与宿主退出这两条路径插件自己碰不到，必须靠宿主状态把 hook 收掉（ADR-0001 后果一节）。
  5. 停用插件 / 关闭联动 → 按宿主持有的联动状态自动卸载 hook；**装**仍然要用户显式点按钮（本轮决定，不要自动装）。
  6. `snapshot()` 里 `installed = files.len() * 12 == managed` 改成按**所选适配器的期望条数**算；
     保留「装了但条数不对 → UI 报『需要修复』而不是『已安装』」这一档。
  7. `PET_AGENT_CONFIG_FILES` 覆盖入口保留，并让它能带适配器 id（测试要在不碰真实用户配置的前提下造出第二个适配器）。
- **明确不做**：不接 zcode/codex/dsh 的真实配置、不给事件加 `agentId` 字段（单联动语义下不需要，且是破坏性变更）、
  不做多 Agent 并行观测、不改 hook 超时（2 秒）、不做"扫描本机装了哪些 Agent"、不动收件目录布局。
- **验收**（下限）：
  - `cargo test --lib` ≥ **70**；新增：qoder 适配器 install/uninstall 的输出与本卡改动前**逐字节相同**
    （用现有单测样例做基线，不许改期望值来"过"）；未验证槽位调 install → 返回错误且**没有任何文件被创建或改写**
    （`temp_dir` 断言目录不变）；switch 事务：模拟"装新失败" → 断言旧条目**已回滚复原**且失败原因可读；
    期望条数按适配器算：12 条齐 → `installed=true`，缺 1 条 → "需要修复"。
  - 幂等与只删自家：连续 install 三次 → `managed` 恒为 12；同一文件里别人的 hook 条目一字未动。
  - `npm run verify-agent-bridge` 在 B2 迁移后的基线上**只增不减**（≥ **50**），新增：联动状态回显、停用自动卸载、
    撤销确认两条分支、切换失败回滚后宠物不再收到旧 Agent 的事件。
  - **两条方向相反的退出断言都要有**：宠物进程结束后 hook 条目**仍在**（退出时不该偷改别人的配置）；
    插件被停用**时**条目必须被收掉。只测其中一条就是漏。
  - 改了 Rust 与命令注册 → `npm run verify:release` ≥ **12**，且 `cargo tree -p tauri` 仍必须是 **2.12.0**。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`cargo test` + `verify-agent-bridge` 尾部汇总与退出码粘贴、
  贴出 qoder 适配器 install 前后同一份样例配置的 diff（应为空或仅顺序稳定）。

## 3. 验收证据矩阵（本体改动必须跑哪个套件）

| 改动落点 | 必须跑 | 上一轮实测断言数（**下限，不许倒退**） |
|---|---|---|
| `src/pet/`（状态机、图集切片、点击穿透、气泡） | `npm run verify` + `npm run verify:skin`（动了形象/协议）+ `verify:game`（动了显隐） | verify 147 / skin 26 / game 15 |
| `src/runtime/`（插件运行时、bridge、widget 宿主、订阅回收） | `npm run verify` | 147 |
| `src-tauri/`（Rust 能力服务、gate、fsutil、hotkeys） | `cargo test --lib` + `npm run verify` + 对应 `verify:<域>` | cargo 70 |
| `http` 能力 / charset 解码 / 重定向 | `npm run verify:http` | 21 |
| Agent hook 链路 | `npm run verify:agent` | 50 |
| 待办链路 | `npm run verify:todo` | 30 |
| A股插件 | `npm run verify:astock` | 154 |
| 任何新增脚本 / 协议源 / CSP / 打包相关 | `npm run verify:release` | 12 |
| Cargo 依赖变动 | `cargo tree -p tauri` 必须仍是 **2.12.0**，且 `npm run verify:release` | — |

**验收纪律**（沿用 PLUGIN-REVIEW §0，此处不复制全文）：跑起来看而不是只读代码；每条问题给 文件:行号 + 触发步骤 +
期望/实际；**「已核不成立」一节必须写**，附证据，别让下一批助手重复提同一件。
额外两条本体域专用：

1. **断言只许变严不许变松**。评审时 diff `scripts/verify-*.mjs`，被删的断言行要逐条在新代码里找到对应的新标签，
   找不到就是放宽回归 —— 直接打回。
2. **`cargo test` / verify 输出取尾部汇总和退出码**，不要凭片段宣布全绿。

## 4. 工程约定（派单时随卡片贴给接活者）

- `npm run verify:game` 会真起一个铺满显示器的窗口，**会抢前台**；脚本被中断时自己收窗不留孤儿，
  但**不要在外面套 `timeout`**（2026-09-30 曾把用户会话压垮过一次）。用户在游戏/演示时不要派需要抢前台的验收。
- 不碰安全软件设置，不加开机自启、不改注册表（`tauri-plugin-autostart` 除外，且那是本体能力）。
- 原子写只用 `src-tauri/src/fsutil.rs::write_atomic` 一份实现，别再复制第四份。
- std Mutex 一律 `unwrap_or_else(|p| p.into_inner())`。
- 宿主日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`，验收时先看它再猜。
