# 插件任务池与派单

维护：负责规划与评审的助手。状态：`待排` / `已派` / `进行中` / `待评审` / `已放行` / `搁置`。
**优先级由用户定**，下面的建议顺序只是按「价值 ÷ 风险」给的意见。

派单前必读：[PLUGIN-HANDBOOK.md](PLUGIN-HANDBOOK.md)（交付标准）、[PLUGIN-REVIEW.md](PLUGIN-REVIEW.md)（验收口径）。

## 0. 派单模板（复制给接活的助手）

```
任务：<插件 id> —— <一句话目标>
必读：docs/PLUGIN-HANDBOOK.md、PLUGIN_SDK.md（§3 能力、§5 widget）、参考实现 plugins/todo 或 plugins/com.pet.astock
边界：只准新增 plugins/<id>/ 与 scripts/verify-<id>.mjs + package.json 一条脚本；
      不得改 src/、src-tauri/、tauri.conf.json、CSP、其他插件目录。需要宿主新能力就停下来提出来。
能力声明：<列出 permissions，并说明每项用在哪>
数据源：<接口/本地文件/事件；有 HTTP 必须先实测一次并把响应样例贴出来，字段口径写进注释>
MVP 范围：<这一轮只做什么>
明确不做：<列出来，防止顺手扩大范围>
验收：<逐条可观察的标准 + 必须有的 verify 断言>
交付：git 提交（不 push）、temp 清空、无遗留进程、verify/verify:<id> 全绿的输出粘贴
```

## 1. 可开工（只用现有能力）

### A1 `com.pet.pomodoro` —— 番茄钟 / 久坐提醒 · 建议优先
- **能力**：`storage`、`widget`、`notify`、`pet:react`、`pet:say`、`bus:publish`
- **数据源**：无网络。纯本地计时。
- **MVP**：25/5 循环，badge 显示剩余时间，到点系统通知 + 宠物反应；设置页可调时长与循环次数并**回显**。
- **明确不做**：跨天统计、任务关联、日历集成。
- **验收**：`verify:pomodoro` 至少覆盖 —— 状态机推进（用注入时钟而不是真等 25 分钟）、停用时定时器归零、
  改一项配置不会把另一项抹回默认、通知与宠物反应链路通。
- **风险点**：这是最容易踩「用 rAF 计时」和「deactivate 不清 interval」两个坑的任务，重点看 §2 生命周期。

### A2 `com.pet.weather` —— 天气 / 空气质量
- **能力**：`http`、`storage`、`widget`、`notify`、`pet:react`
- **数据源**：先实测再定（和风/彩云/开源气象都有配额与鉴权差异）。**要求**：UTF-8 JSON、免注册或用户自填 key、
  响应样例贴进 PR；若返回非 UTF-8 编码，宿主 http 目前按 UTF-8 lossy 解码，中文会乱 → 换源，不要改本体。
- **MVP**：单城市（用户填城市名或经纬度）当前温度 + 今日区间，badge 一行，设置页可换城市与切换单位。
- **验收**：出网必须走单一口子且带节流与冷却（照 `plugins/com.pet.astock/throttle.js` 的范式）；
  接口挂了界面显示错误行而不是空；城市名等外部值只走 `textContent`。
- **风险点**：天气接口比行情更容易限流；免费源经常改字段。要求作者把「实测日期 + 响应样例」写进注释。

### A3 `com.pet.github-notify` —— GitHub 通知 / PR 待我审
- **能力**：`http`、`storage`、`widget`、`notify`、`bus:publish`
- **数据源**：GitHub REST（`api.github.com`），需要用户自填 token（设置页输入，只进插件隔离存储）。
- **MVP**：轮询 `/notifications` 未读数，badge 显示；有新通知弹一次系统通知；设置页可设轮询间隔与仓库过滤。
- **验收**：token 不出现在任何日志与错误信息里（评审会 grep）；401/403 与 429 分开处理（GitHub 的 403 常是限流，
  带 `Retry-After` 时要按它冷却）；无新数据时指数退避。
- **风险点**：凭据处理是 P0 检查项；跨主机重定向已由宿主逐跳校验，不要自己再实现一套。

### A4 `com.pet.habit` —— 每日打卡 / 连续天数
- **能力**：`storage`、`widget`、`pet:react`、`bus:publish`
- **数据源**：无网络。
- **MVP**：若干条目，每天可打卡一次，badge 显示今日完成度，设置页列历史（最近 30 天）。
- **明确不做**：提醒时间、云同步、统计图表。
- **验收**：日期边界（本地时区、跨零点、闰日）有纯函数单测；存储结构升级有迁移或明确丢弃；
  打卡幂等（连点两次只算一次）。
- **风险点**：时区与「今天」的定义最容易写出只在开发机对的逻辑。

### A5 `com.pet.fx-watch` —— 汇率 / 加密货币盯价
- **能力**：`http`、`storage`、`widget`、`overlay`、`notify`、`pet:react`、`pet:say`
- **数据源**：公开行情（需实测）。**要求复用 A 股插件的三件事**：批量请求带走全部标的、单开 `:panel` topic 传序列、
  出网走节流+冷却。
- **MVP**：自选若干标的 + 到价提醒 + badge/overlay 显示。
- **验收**：`verify:fx` 覆盖授权、落盘、提醒链路、停用回收；7×24 市场**没有休市退避**，
  所以更要看「价格不前进就拉长间隔」是否生效（加密货币价格几乎总在动，这里要重新定义"无进展"）。
- **风险点**：直接照抄 astock 会漏掉「24/7 市场没有收盘这个概念」，退避条件要重新设计。

### A6 `com.pet.clipboard-lite` —— 剪贴板便签（**受限版**）
- **能力**：`storage`、`widget`、`notify`
- **MVP**：用户在设置页**手动粘贴**一段文本存成便签（多标签、时间戳、过期）。
- **说明**：**不做自动读取剪贴板** —— 那需要宿主新增能力（见 §2 P1）。这个卡片的价值是「便签 + 过期」，
  不是监听。
- **验收**：便签内容是不可信输入，渲染必须 `textContent`；超长文本要截断且存储不爆。

### A7 `todo` 增强 —— 重复任务与自然语言日期
- **能力**：沿用现有 `todo` 插件（不新增权限）
- **范围**：`rec:` 重复规则（每天/每周/工作日）、到期顺延、`+项目` 过滤视图。
- **约束**：**必须保持 todo.txt 字段兼容**，不能改动已落盘数据的语义；`todo:changed` 的 payload 结构不能破坏性变更
  （别的插件会订）。
- **验收**：`verify:todo` 现有 30 条必须继续全绿，新增断言覆盖重复展开与时区。
- **风险点**：这是**改已有插件**，回归面比新插件大；要求作者先跑通原 verify 再动手。

### A8 `com.pet.astock` 增强 —— 行情源故障切换（多源 failover）· 状态：待排（**依赖 §2.1 B1**）
- **任务**：东财接口不可达时，插件自动切到腾讯/新浪继续出数，而不是整块显示错误行。
- **为什么现在做（2026-10-09 实测，规划方自己跑的）**：本机 shell 里东财**四个入口全部 socket 层被重置**
  （`push2` / `push2delay` / `79.push2his` / 明文 `http://push2`，Node 报 `UND_ERR_SOCKET`，curl/schannel 报
  `server closed abruptly (missing close_notify)`；`push2` 被解析到 `47.112.165.11` 这个阿里云 IP），
  同一时刻 `www.baidu.com`、`petdex.dev`、`qt.gtimg.cn`、`hq.sinajs.cn` 都是 200。
  **所以这不是反爬限流，是本机网络路径对 eastmoney 域名的拦截**——现有节流解决不了它，只有换源能。
  插件当前把五个东财域名硬编在 `plugins/com.pet.astock/market.js:11-15`，且只有一个源。
- **必读**：`D:\test\desktop-pet\docs\PLUGIN-HANDBOOK.md`、`PLUGIN_SDK.md` §3 能力表、
  参考实现 `plugins/com.pet.astock/market.js`（纯函数分层）与 `throttle.js`（节制范式）。
- **边界**：只准改 `plugins/com.pet.astock/` 内的 `market.js`、`index.js`、`rules.js`、`widget.js` 与
  `scripts/verify-astock.mjs`。**不得**改 `src/`、`src-tauri/`、`tauri.conf.json`、其他插件目录。
  出网**必须继续走 `index.js:111` 的 `out()`**，不许任何一处直接调 `ctx.http.request`（AGENTS.md 明令，评审会 grep）。
  需要宿主新能力就停下来提出来 —— 本页 §2.1 B1 就是为这件事开的，别自己绕。
- **能力声明**：沿用现有 manifest 的 `http`（域名授权按 `http:<host>` 逐域名走，新增 `qt.gtimg.cn`、`hq.sinajs.cn`
  会在首次请求时各弹一次同意框，**不需要也不允许改 manifest 权限项**）。其余能力不新增。
- **数据源**（以下样例为 2026-10-09 15:22 实测真实返回，非构造）：
  - 腾讯批量：`https://qt.gtimg.cn/q=sh600000,sz300750` → `Content-Type: text/html; charset=GBK`，
    响应形如 `v_sh600000="1~浦发银行~600000~9.54~9.70~9.70~947958~449628~498330~9.54~…"`，`~` 分隔共 88 段。
    已核对下标：`1`名称 `2`代码 `3`现价 `4`昨收 `5`今开 `6`成交量(**手**) `30`时间 `31`涨跌额 `32`涨跌幅(%) `33`最高 `34`最低。
  - 新浪批量：`https://hq.sinajs.cn/list=sh600000,sz300750` → `Content-Type: application/javascript; charset=GB18030`，
    **必须带 `referer: https://finance.sina.com.cn`**（不带是否 403 由接活者实测后写进注释）。
    `,` 分隔：`0`名称 `1`今开 `2`昨收 `3`现价 `4`最高 `5`最低 `8`成交量(**股**) `9`成交额(元) `30`日期 `31`时间。
  - **两源口径对齐证据**（同花名同股票同一天）：腾讯 `6`=947958 手 vs 新浪 `8`=94795849 股（÷100 一致）；
    腾讯 `35` 段内 `9.54/947958/915309833` vs 新浪 `9`=915309833.000 元。涨跌幅一律**自己用现价与昨收算**，
    不要读 `32` 段（休市/停牌时各家给的口径不一样）。
  - 两源都是 **GBK/GB18030 非 UTF-8**：宿主 `src-tauri/src/services/http.rs:176` 现在是
    `String::from_utf8_lossy`，中文名会变成 `\ufffd`。**这一条由 §2.1 B1 收口，B1 没落地之前本卡片只能做东财多节点那半段**，
    别用 lossy 之后的乱码硬接。
- **派单顺序（重要）**：**B1 必须先放行，再派 A8 的换源部分**。
  「东财主节点 → `push2delay` 延迟节点」那一档在**当前这台机器上无法验收**（所有 eastmoney 域名都被重置），
  要么等网络环境换掉再验，要么在单测里用注入的假 fetch 证明切换逻辑，不要在真机上为它花时间。
- **MVP 范围**：
  1. 源注册表：每个源一个 `{ id, hosts, buildUrl(secids), parse(body) → Quote[] }`，`Quote` 用插件现有字段名，
     解析函数写成 market.js 那种纯函数（不碰 http、不碰 DOM），每个源单独一套下标映射；
  2. 按源记住「上一次成功的源」，下一轮先试它；连续失败才依次下移，全部失败保留现有错误行显示；
  3. 轮询快照（`ulist.np/get` 那条批量路径）走 failover；面板（分时/K线/五档）**这轮仍只走东财**，
     失败就显示现有错误行；
  4. 源标识进 `*:widget` 的现有 `net` 字段（如「数据源 腾讯」），让用户看得见当前吃的是哪家。
- **明确不做**：自建服务器/云端代理（规划已否决，理由见 §3）、换 UA 伪装浏览器、
  WebSocket 实时推送、Level-2、新增图表或面板、把东财字段映射改成多源共用一套、任何本体改动。
- **验收**：`npm run verify:astock` 现有断言必须继续全绿，另加——
  - 注入失败：把东财 fetch 打成异常后能自动切到下一源并真的拿到现价（不要靠真断网测）；
  - 三源对同一只股票解出的 现价/昨收/成交量 数值一致（按上面的实测样例写固定输入的单测，不依赖当时是否开盘）；
  - 「记住上一次成功的源」生效：连续两轮只在第一轮撞失败源；
  - 全部源失败 → 界面是错误行而不是空白，且**不会**把上一次的旧数据当新数据广播；
  - 出网计数仍只增在 `out()` 一处（grep 断言：`ctx.http.request` 在 `index.js` 之外没有新调用点）；
  - 时段无关（照现有约定：有价才比大小、无价必无量）。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`verify:astock` 全绿输出粘贴；
  注释里写清每个源的**实测日期**与字段下标来源。

## 2. 需要宿主新能力 —— 先提案，不要开工

这些卡片**当前无法在插件内正确实现**，接活的助手如果硬做会写出错误的近似物。要做的先交一份提案：
需要什么 API、最小签名、权限名、宿主侧风险。

| 想要的能力 | 为什么插件做不到 | 提案要写清 |
|---|---|---|
| 剪贴板监听 | 无剪贴板 API，WebView 也不给后台读 | 是「变化通知」还是「主动读取」；隐私边界；是否需要开关 |
| 前台窗口/活动应用识别 | 宿主只有全屏检测（`host:fullscreen`），且是宿主窗口事件，插件收不到 | 用途、粒度、会不会变成监控；是否只暴露「游戏模式」这类布尔 |
| 音频/媒体播放状态 | 无系统媒体会话 API | 只读还是要控制；平台差异 |
| 文件系统读写用户任意路径 | 存储被隔离在插件目录，这是刻意的 | 用 `dialog` 选一次 + 记权限，还是长期目录授权 |
| 开机时间/空闲时长 | 无系统信息 API | 只要「空闲多久」还是精确时间轴 |
| 本地端口/局域网通信 | 宿主不开本地端口（历史上明确否决） | 安全评审先过 |
| **http 响应按 charset 解码（GBK/GB18030）** | 插件拿到的是宿主 lossy 后的字符串，乱码已经在 Rust 侧产生，JS 里救不回来 | **已定方案，见下面 §2.1 B1，可直接开工** |

### 2.1 卡片 B1 `宿主 http 能力` —— 响应按 charset 解码 · 状态：待排 · **A8 的前置**
- **任务**：`ctx.http.request` 对非 UTF-8 响应（`charset=GBK` / `GB18030`）返回正确字符串，UTF-8 行为一字不变。
- **任务类型**：**这是本体改动**，§0 模板里「不得改 `src/`、`src-tauri/`」那条边界在本卡片内被下面的白名单覆盖。
  **只准动这些文件**，其余一律不碰：
  - `D:\test\desktop-pet\src-tauri\src\services\http.rs`
  - `D:\test\desktop-pet\src-tauri\Cargo.toml`、`D:\test\desktop-pet\src-tauri\Cargo.lock`
  - `D:\test\desktop-pet\src\runtime\bridge.ts`
  - `D:\test\desktop-pet\PLUGIN_SDK.md`
  - `D:\test\desktop-pet\scripts\verify.mjs`（或新加 `scripts/verify-http.mjs` + package.json 一条脚本）
  不得改 `tauri.conf.json`、CSP、`plugins/` 下任何文件、其他 Rust service 模块。
- **为什么必须动本体**：`http.rs:176` 现在是 `body: String::from_utf8_lossy(&buf).into_owned()`。
  乱码在这一步产生，插件侧拿到已经是坏字符串，**没有纯插件解法**（`resp.body` 是 string，字节早就丢了；
  base64 透传要在 Rust 加字段并让每个插件自己解码，比本方案更脏）。
  项目记忆里「腾讯/新浪因编码未接线」记的就是这一条。
- **方案（已定，别再选）**：
  1. 依赖：`encoding_rs`（纯 Rust、WHATWG 编码表、与 tauri 无版本耦合）。加完**必须**跑
     `cargo tree -p tauri` 确认 tauri 仍是 `2.12.0`（`Cargo.lock:3913-3915`），
     并在收尾跑 `npm run verify:release` —— 本项目踩过「cargo 抬 tauri minor 而 npm 侧没动 → build 直接失败」。
  2. 解码收在 `read_body` 一处：从已有的 `content_type`（`http.rs:161` 已经拿到并回传）里取 `charset=` 参数，
     **先 lowercase + trim 再查表**（腾讯真实回的是 `charset=GBK` 大写），命中 `gbk`/`gb2312`/`gb18030` 时
     用 `encoding_rs` 解码，**其余一切情况保持现在的 `from_utf8_lossy`**。
     解码失败或该编码是 decoder 有特殊语义的（utf-16 之类）→ 回落 lossy，不要抛。
  3. 不给请求侧加 `charset` 覆盖参数。两个实测源的 `Content-Type` 都自带 charset，加参数就是多一条
     要过 Rust 校验、要写进 SDK、要被插件误用的面。**真需要覆盖时再提新卡。**
  4. `bridge.ts:178-197` 的 `http.request` 签名与返回结构不变（`{status, contentType, body, truncated}`），
     插件侧零改动；PLUGIN_SDK.md 第 68/93 行那两处只补一句「body 按响应 `Content-Type` 的 charset 解码，
     目前支持 UTF-8 与 GBK/GB18030，其余仍按 UTF-8 lossy」。
- **数据源/实测依据**（2026-10-09，规划方本机实跑）：
  - `https://qt.gtimg.cn/q=sh600000` → `200`，`Content-Type: text/html; charset=GBK`，GBK 解码后 `1` 段是 `浦发银行`；
  - `https://hq.sinajs.cn/list=sh600000`（带 `referer: https://finance.sina.com.cn`）→ `200`，
    `Content-Type: application/javascript; charset=GB18030`，解码后为
    `var hq_str_sh600000="浦发银行,9.700,9.700,9.540,9.740,…,2026-10-09,15:23:03,00,…`；
  - 现有东财响应是 UTF-8 JSON，属第 2 条的「其余一切」，行为必须不变。
- **MVP 范围**：上面 4 条，做完就停。
- **明确不做**：不缓存、不改 `MAX_BODY_BYTES`、不碰重定向与逐跳授权逻辑、不动 `is_credential_header`、
  不加 `charset` 请求参数、不做 gzip/br（ureq 现有行为照旧）、不顺手清理 http.rs 里其他代码。
- **验收**（`cargo test` + 运行时断言都要有）：
  - 单测：`charset=GBK`（大写）的 body 字节 → `浦发银行` 正确；`charset=GB18030` → 同；
  - **回归**：无 charset、`charset=utf-8`、非法 charset 字符串三种输入，输出与改动前逐字节相同
    （用一条含非法 UTF-8 字节的样例证明 lossy 回落没被改掉）；
  - charset 提取不被 `text/html;charset=gbk;` 这种带尾分号/无空格的写法带偏；
  - 运行时：从真实 webview 里请求 `qt.gtimg.cn` 与 `hq.sinajs.cn`，断言拿到的中文名含 `浦发银行`
    且**不含** `\ufffd`（这条是整张卡的目的，不能只留 Rust 单测）；
  - 首次请求这两个域名会各弹一次域名同意框 —— 断言授权键是 `qt.gtimg.cn` / `hq.sinajs.cn`
    **不带 `:443`**（AGENTS.md 记着这个坑，本地带端口地址会把它藏住）；
  - `npm run verify` 全绿 + `npm run verify:release` 全绿（打包版 CSP 不受影响但必须确认）。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`cargo tree -p tauri` 输出粘贴、
  两个 verify 全绿输出粘贴。
- **落地后要回改的两处**：① §1 卡片 A2（天气）里那句「若返回非 UTF-8 编码，宿主 http 目前按 UTF-8 lossy 解码，
  中文会乱 → 换源，不要改本体」在本卡片落地后就不再成立，改成「charset 声明 GBK/GB18030 的源现在可以直接用」；
  ② 通知规划方更新 AGENTS.md 的对应约定行（那条决策不该由接活者改，本体约定由规划方维护）。


## 3. 已定搁置（别自作主张开工）

- `llm-token-usage` 示例插件：**用户已明确暂缓**（2026-10 记录在 AGENTS.md）。要重启需要先问用户。
- **自建云服务器/云端代理统一抓行情（客户端只读自家代理）：本波次否决**（2026-10-09 评估）。
  理由：① 单用户单实例，服务端合批省下的请求数接近零（一次批量快照本来就把全部自选带走）；
  ② 机房 IP 被风控的概率大概率高于家宽，而现在是单点失效 —— 服务挂了或你的出口 IP 被拉黑就是全局无数据，
  而现在客户端的限流只是临时降级（`throttle.js` 60s→30min 阶梯）；
  ③ 代理不加鉴权就变成开放代理，别人拿它撞东财，被封的是你的 IP、流量费你出；
  ④ 授权模型退化：`http:<host>` 逐域名授权 + 逐跳重定向重校验（AGENTS.md）在"只有一个自家域名"这个前提下失去意义。
  **注意有个真实反例要如实记着**：本机对 eastmoney 域名的拦截（见 A8 开头实测）确实是"换条网络路径就能解决"的问题，
  代理能绕，家宽换 IP 也能绕 —— 但成本更低的绕法是 §2.1 + A8 的换源，不是养一台服务器。
  什么时候该重开这条：多设备共用一个宠物、要做全市场扫描级请求量、或要缓存历史 K 线做回测。
- 把 `plugins/` 在构建期复制进 `dist/`：**已否决**，会让「放进目录即生效」在打包版失效。
- 引入第三方图表/日期/UI 库进插件运行时：CSP 的 `script-src` 只放行 petplugin 协议，
  且 widget 在 closed Shadow DOM 里，手写更可控（A 股插件的 canvas 图表是参照）。

## 4. 现状参照

已放行插件：`com.pet.hr-ble`（蓝牙心率）、`com.pet.agent-bridge`（Agent 会话驱动宠物）、
`todo`（待办）、`com.pet.astock`（A股盯盘：自选+提醒+badge/overlay+分时/K线/五档+出网节制）。
新插件的目录结构、纯函数分层、verify 脚本写法优先照 `com.pet.astock` 与 `todo` 抄。
