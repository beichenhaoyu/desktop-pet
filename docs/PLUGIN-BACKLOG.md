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

### A8 `com.pet.astock` 增强 —— 行情源故障切换（多源 failover）· 状态：待排
**拆两阶段派单：阶段一（面板）可立即开工、零本体依赖；阶段二（实时快照与五档）依赖 §2.1 B1。**

- **任务**：东财行情接口不可达时，插件自动切到腾讯继续出数，而不是整块显示错误行。
- **为什么现在做**：2026-10-09 规划方在本机实跑，东财**行情 API 主机整组不可达**，而腾讯、新浪全通。
  插件把五个东财域名硬编在 `plugins/com.pet.astock/market.js:11-15`，只有一个源，所以现在是**盘面整块无数据**。

#### 故障分层实测（决定手段有没有用，接活者别再自己试一遍）

| 目标 | 结果 |
|---|---|
| `push2.eastmoney.com` → 本机 DNS 的 `47.112.165.11` | `ECONNRESET` ~137ms |
| `push2.eastmoney.com` → 公共 DNS 的 `117.184.38.132` | `ECONNRESET` ~114ms |
| 同一 IP `117.184.38.132`，SNI 换成 `push2delay` | `ECONNRESET` ~92ms |
| 明文 `http://push2.eastmoney.com`（无 TLS） | `UND_ERR_SOCKET` ~102ms |
| `push2his` / `79.push2his` | `ECONNRESET` |
| `www.eastmoney.com` / `quote.eastmoney.com` / `emweb.securities.eastmoney.com` / **`searchadapter.eastmoney.com`** | **200 全通** |
| `www.baidu.com` / `petdex.dev` / `qt.gtimg.cn` / `hq.sinajs.cn` / `proxy.finance.qq.com` | 200 全通 |

三条结论，都必须遵守：
1. **拦截按 `push2*` 这批行情主机来，不是整个 eastmoney** —— 所以自选股搜索（`SUGGEST_API`，走 searchadapter）**现在是好的，不要给它做 failover**。
2. **连接死在 TLS ClientHello**（curl 侧日志：`remote party requests renegotiation` → `server closed abruptly (missing close_notify)`），HTTP 请求还没产生就被 RST。
   **所以换 `user-agent` / 加 `cookie` / 补全套浏览器请求头，对本故障零作用**——那些是 L7 的东西，这里连不到 L7。评审看到"换 UA 试试"的提交会退单。
3. 换目标 IP 也无效（两个 IP 都 RST，同 IP 换 SNI 也 RST）→ 这是网络路径按域名匹配，不是坏 CDN 节点。**客户端唯一有效的手段是换源。**

#### 各条 API 的可用性与我们安排的后端

| 插件取数 | 东财现状 | 后端 | 需要 B1？ |
|---|---|---|---|
| 日/周 K 线（`KLINE_API`） | `push2his` RST，**废** | 腾讯 `proxy.finance.qq.com` **UTF-8** | 否 |
| 分时（`TREND_API`） | `push2his` RST，**废** | 腾讯 `minute/query` **UTF-8** | 否 |
| 实时快照（`QUOTE_API`） | `push2` RST，**废** | 腾讯 `qt.gtimg.cn` GBK / 新浪 `hq.sinajs.cn` GB18030 | **是** |
| 五档（`DETAIL_API`） | `push2` RST，**废** | 同上（腾讯 `9..28` 段） | **是** |
| 自选股搜索（`SUGGEST_API`） | **通** | 不动 | 否 |

#### 数据源实测样例（2026-10-09 15:22 真实返回，非构造；注释里要标实测日期）

- **腾讯 K 线**（阶段一）`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=sh600000,day,,,250,qfq`
  → 200，`Content-Type: text/html; charset=UTF-8`，`data.sh600000.qfqday` 是数组的数组，
  **列序 `[日期, 开, 收, 高, 低, 量(手)]`**，与插件现有 `market.js:231` 那句
  「f51 时间、f52 开、f53 收、f54 高、f55 低、f56 量(手)」同序（该函数已实测对过，可直接复用其列下标）。
  `param` 第 2 段 `day`/`week`，末段 `qfq`；`week` 是真实周线（不像东财 `klt=102` 会退化成日线，见 AGENTS.md 坑 ①）。
  同 URL 换 host 为 `web.ifzq.gtimg.cn` / `ifzq.gtimg.cn` 可作后备入口，但**高频会触发 501**，所以面板照旧走 `out()` 的节流。
- **腾讯分时**（阶段一）`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/minute/query?code=sh600000`
  → 200，UTF-8，`data.sh600000.data.data` 每项形如 `"0930 9.70 4256 4128320.00"`，空格分隔：
  `时间 价格 量 额`。**实测第 3、4 列单调递增**（4256→26626→34223），据此判为**当日累计量/累计额**——
  这正好对上东财 `trends2` 的口径差异（AGENTS.md 坑 ②：`trends2` 最后一列是当日累计均价）。
  接活者**必须用同一只股票同一时刻的东财数据交叉验证后再定第 4 列是「累计额」还是「累计均价」**，验证结论写进注释；
  验证不了就只用前 3 列画分时线，第 4 列不显示。
- **新浪日 K**（阶段一的第二后端）
  `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=sh600000&scale=240&ma=no&datalen=250`
  → 200，`Content-Type: application/javascript; charset=gbk` 但**本次响应体是纯 ASCII**（数字与日期，UTF-8 与 GBK 都合法）；
  每行 `{day,open,high,low,close,volume}`，注意它是**对象数组不是数组的数组**，且列序是 `开高低收`（**与腾讯/东财的 `开收高低` 不同，必须显式映射**）。
  `volume` 数值量级判为**股**（≈手数的 100 倍），**要求实测交叉验证后才可用**。`scale` 取 5/15/30/60/240（分钟/日），
  它给的是历史 bar，**没有当日分时** —— 分时只用腾讯。
- **腾讯实时快照**（阶段二）`https://qt.gtimg.cn/q=sh600000,sz300750` → 200，`charset=GBK`，`~` 分隔共 88 段：
  `1`名称 `2`代码 `3`现价 `4`昨收 `5`今开 `6`成交量(**手**) `30`时间 `31`涨跌额 `32`涨跌幅(%) `33`最高 `34`最低，
  **`9..18` 买一至买五、`19..28` 卖一至卖五，价格/量(手)交替**（实测 `9.54/9.53/9.52/9.51/9.50` 递减、`9.55/9.56/9.57/9.58/9.59` 递增，
  买一 9.54 与卖一 9.55 正好贴着现价，可直接作五档后端）。
- **新浪实时快照**（阶段二第三顺位）`https://hq.sinajs.cn/list=sh600000,sz300750` → 200，`charset=GB18030`，
  **必须带 `referer: https://finance.sina.com.cn`**（不带就 403，2026-10-08 实测记录）。
  `,` 分隔：`0`名称 `1`今开 `2`昨收 `3`现价 `4`最高 `5`最低 `8`成交量(**股**) `9`成交额(元) `30`日期 `31`时间。
- **跨源口径对齐证据**（同一只同日）：腾讯 `6`=947958 手 vs 新浪 `8`=94795849 股（÷100 吻合）；
  腾讯 `35` 段内 `9.54/947958/915309833` vs 新浪 `9`=915309833.000 元。
  **涨跌幅一律自己用现价与昨收算**，不读腾讯 `32` 段（休市/停牌时各家口径不一致）。
- **为什么快照必须等 B1，而面板不用**（这条是阶段划分的唯一依据，别自作主张合并）：
  面板两条腾讯接口回的是 UTF-8，宿主现有 `from_utf8_lossy` 不损坏任何东西。
  快照的名称段（下标 `1`）排在全部数字段**之前**，而**宿主 lossy 解码会把非法 UTF-8 字节换成 `\ufffd`**——
  实测 30 只常见 A股名称下标没有错位（`split("~").length` 与 GBK 正确解码完全一致），
  **但 GBK 的尾字节允许 `0x7E`，也就是一个汉字的第二个字节可以正好是 `~`**，所以这是「暂未观察到」而不是「不可能」。
  一旦发生就是**下标整体左移一位**：把「今开」当「现价」、把「最高」当「昨收」，
  而**到价提醒和涨跌阈值建立在现价上，静默错价比显示乱码严重得多**（P0 级）。
  所以阶段二必须等 B1 的干净解码，并且解析器要写成**校验不通过就判该源失败并下移**：
  段数必须等于 88（新浪 32）、现价/昨收必须是有限正数、`3` 段必须能对上自选列表里的代码。

- **必读**：`D:\test\desktop-pet\docs\PLUGIN-HANDBOOK.md`、`PLUGIN_SDK.md` §3 能力表、
  参考实现 `plugins/com.pet.astock/market.js`（纯函数分层、`parseKlineLine` 的列序注释）与 `throttle.js`（节制范式）。
- **边界**：只准改 `plugins/com.pet.astock/` 内的 `market.js`、`index.js`、`rules.js`、`widget.js` 与
  `scripts/verify-astock.mjs`。**不得**改 `src/`、`src-tauri/`、`tauri.conf.json`、其他插件目录。
  出网**必须继续走 `index.js:111` 的 `out()`**，不许任何一处直接调 `ctx.http.request`（AGENTS.md 明令，评审会 grep）。
  需要宿主新能力就停下来提出来 —— 本页 §2.1 B1 就是为这件事开的，别自己绕，更别用「按下标硬取」绕开编码问题。
- **能力声明**：沿用现有 manifest 的 `http`（域名授权按 `http:<host>` 逐域名走，新增
  `proxy.finance.qq.com`、`qt.gtimg.cn`、`hq.sinajs.cn` 会在首次请求时各弹一次同意框，
  **不需要也不允许改 manifest 权限项**）。其余能力不新增。
- **MVP 范围**：
  - **阶段一（现在就能派）**：K 线与分时的多源。
    1. 源注册表：每个源一个 `{ id, hosts, buildUrl(), parse(body) → 现有内部结构 }`，
       parse 写成 market.js 那种纯函数（不碰 http、不碰 DOM），**每个源单独一套列序映射，不许把东财映射改成多源共用**；
    2. 记住「上一次成功的源」，下一轮先试它，连续失败才依次下移，全失败保留现有错误行；
    3. 面板现有的 `PANEL_TTL_MS` 90 秒续期机制对后端源同样生效（人走了额外出网要自己停，AGENTS.md 已定这条）。
  - **阶段二（B1 放行后再派）**：实时快照 + 五档多源，源序 `东财 → 腾讯 → 新浪`。
    源标识进 `*:widget` 的现有 `net` 字段（如「数据源 腾讯」），让用户看得见当前吃的是哪家。
  - **两阶段共用**：切换与失败原因进 `ctx.log`，界面只在「全部源都失败」时显示错误行。
- **明确不做**：自建服务器/云端代理（规划已否决，理由见 §3）、**换 UA 或补浏览器头**（上表第 2 条已证明无效）、
  给 `SUGGEST_API` 做 failover（它现在是通的）、周/月 K 加进 `KLINE_PERIODS`（东财退化那条坑仍在，
  腾讯 `week` 虽真但要另开卡实测才许加）、WebSocket 实时推送、Level-2、新增图表或面板、任何本体改动。
- **验收**：`npm run verify:astock` 现有断言必须继续全绿，另加——
  - **阶段一**：注入东财 fetch 抛错后，K 线与分时都能自动落到腾讯并真的拿到数据（不要靠真断网测）；
    腾讯 K 线的 `[日期,开,收,高,低]` 与新浪 K 线的 `{day,open,high,low,close}` **对同一交易日解出同一组数**（固定输入单测）；
    分时第 4 列的「累计额 vs 累计均价」交叉验证结论要么写进注释并显示，要么按「不显示」处理——**不许猜着显示**；
    新浪 `scale=240` 的 `volume` 单位验证后才有断言，未验证就只断言「有量」；
  - **阶段二**：三源对同一只股票解出的 现价/昨收/成交量 数值一致；五档买一≤现价≤卖一（有价才比、无价必无量）；
    **段数校验**：喂一段名称含 `~` 的样例（构造 GBK 尾字节场景），解析必须判失败而不是把后移的字段当价格用；
  - **两阶段**：「记住上一次成功的源」生效（连续两轮只在第一轮撞失败源）；全部源失败 → 错误行而不是空白，
    且**不会**把上一次的旧数据当新数据广播；出网计数仍只增在 `out()` 一处（grep 断言）；时段无关（照现有约定）。
- **派单顺序**：**阶段一先派，不等任何人**。B1（§2.1）走宿主改动流程，放行后再派阶段二。
  「东财主节点 → `push2delay` 延迟节点」那一档在本机**当前无法验收**（`push2*` 整组被 RST），
  要么等网络环境换掉再验，要么在单测里用注入的假 fetch 证明切换逻辑，不要在真机上为它花时间。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`verify:astock` 全绿输出粘贴；
  注释里写清每个源的**实测日期**、字段下标来源，以及上面两处「必须交叉验证」的结论。

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
| **http 响应按 charset 解码（GBK/GB18030）** | 插件拿到的是宿主 lossy 后的字符串，乱码已经在 Rust 侧产生，JS 里救不回来；对**分隔符格式的行情文本**（腾讯 `~` 分段）后果比乱码更重——GBK 尾字节允许 `0x7E`，会把字段下标整体挪一位，价格错位是静默的（详见 A8 的阶段划分依据） | **已定方案，见下面 §2.1 B1，可直接开工** |

### 2.1 卡片 B1 `宿主 http 能力` —— 响应按 charset 解码 · 状态：待排 · **A8 阶段二的前置（阶段一不等它）**
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
  **注意有个真实反例要如实记着**：本机网络对 `push2*` 这批东财行情主机的 TLS 层重置（范围与证据见 A8 开头的分层实测表——
  `www`/`quote`/`searchadapter` 都通，所以是针对性拦截而不是整域封锁）确实是"换条网络路径就能解决"的问题，
  代理能绕，家宽换 IP 也能绕 —— 但成本更低的绕法是 §2.1 + A8 的换源，不是养一台服务器。
  什么时候该重开这条：多设备共用一个宠物、要做全市场扫描级请求量、或要缓存历史 K 线做回测。
- 把 `plugins/` 在构建期复制进 `dist/`：**已否决**，会让「放进目录即生效」在打包版失效。
- 引入第三方图表/日期/UI 库进插件运行时：CSP 的 `script-src` 只放行 petplugin 协议，
  且 widget 在 closed Shadow DOM 里，手写更可控（A 股插件的 canvas 图表是参照）。

## 4. 现状参照

已放行插件：`com.pet.hr-ble`（蓝牙心率）、`com.pet.agent-bridge`（Agent 会话驱动宠物）、
`todo`（待办）、`com.pet.astock`（A股盯盘：自选+提醒+badge/overlay+分时/K线/五档+出网节制）。
新插件的目录结构、纯函数分层、verify 脚本写法优先照 `com.pet.astock` 与 `todo` 抄。
