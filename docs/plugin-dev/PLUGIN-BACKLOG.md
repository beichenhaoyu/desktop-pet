# 插件任务池与派单

维护：负责规划与评审的助手。状态：`待排` / `已派` / `进行中` / `待评审` / `已放行` / `搁置`。
**优先级由用户定**，下面的建议顺序只是按「价值 ÷ 风险」给的意见。

派单前必读：[PLUGIN-HANDBOOK.md](PLUGIN-HANDBOOK.md)（交付标准）、[PLUGIN-REVIEW.md](PLUGIN-REVIEW.md)（验收口径）。

## 0. 派单模板（复制给接活的助手）

```
任务：<插件 id> —— <一句话目标>
必读：docs/plugin-dev/PLUGIN-HANDBOOK.md、docs/plugin-dev/PLUGIN_SDK.md（§3 能力、§5 widget）、参考实现 plugins/com.pet.todo 或 plugins/com.pet.astock
边界：只准新增 plugins/<id>/ 与 tests/e2e/verify-<id>.mjs + package.json 一条脚本；
      不得改 src/、src-tauri/、tauri.conf.json、CSP、其他插件目录。需要宿主新能力就停下来提出来。
能力声明：<列出 permissions，并说明每项用在哪>
数据源：<接口/本地文件/事件；有 HTTP 必须先实测一次并把响应样例贴出来，字段口径写进注释>
MVP 范围：<这一轮只做什么>
明确不做：<列出来，防止顺手扩大范围>
验收：<逐条可观察的标准 + 必须有的 verify 断言>
交付：git 提交（不 push）、temp 清空、无遗留进程、verify/verify:<id> 全绿的输出粘贴
```

## 1. A1–A7 用户已否决 —— 不要接这些卡（2026-10-10）

下面 **A1 到 A7** 是规划方拟的候选，**用户明确表示不是他想要的插件**。留着只作历史记录，
不要据此开工，也不要"顺手做一个"。要新插件请等用户直接提需求。
（A8 与 B1 不在此列，它们已交付并放行，见 §1.1 与 §2.1。）

### A1 `com.pet.pomodoro` —— 番茄钟 / 久坐提醒
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
  响应样例贴进 PR；响应头声明 `charset=GBK` / `GB18030` 的源现在可以直接用（B1 已落地，宿主按 charset 解码），
  其余非 UTF-8 且宿主认不出的编码（Big5、Shift_JIS 等）仍然会 lossy 成乱码 → 那种就换源，不要改本体。
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
- **约束**：**必须保持 todo.txt 字段兼容**，不能改动已落盘数据的语义；`com.pet.todo:changed` 的 payload 结构不能破坏性变更
  （别的插件会订）。
- **验收**：`verify:todo` 现有 30 条必须继续全绿，新增断言覆盖重复展开与时区。
- **风险点**：这是**改已有插件**，回归面比新插件大；要求作者先跑通原 verify 再动手。

## 1.1 已交付（不在否决范围内）

### A8 `com.pet.astock` 增强 —— 行情源故障切换（多源 failover）· 状态：**阶段一与阶段二均已放行**（`98ab2dc` / `274faa9`，评审见 §5）
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
  **`47` 涨停价、`48` 跌停价**（阶段二复查实测，三个板块都对得上，语义等价于东财 `f51/f52` 的「交易所给的价」）：
  沪主板 `sh600000` 昨收 9.70 → 47=`10.67`、48=`8.73`（±10%）；创业板 `sz300750` 昨收 286.75 → 47=`344.10`（+20%）；
  北交所 `bj920185` 昨收 21.01 → 47=`27.31`、48=`14.71`（±30%）。
  **所以阶段二换到腾讯后，涨跌停仍然不必按代码前缀猜**（AGENTS.md 坑 ① 那条结论继续成立，ST 是否也偏窄未测）。
  北交所快照本身可用：`v_bj920185="62~贝特瑞~920185~21.82~…"`，市场 flag 段是 `62`，名称经 B1 解码正常。
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

- **必读**：`D:\test\desktop-pet\docs\plugin-dev\PLUGIN-HANDBOOK.md`、`docs/plugin-dev/PLUGIN_SDK.md` §3 能力表、
  参考实现 `plugins/com.pet.astock/market.js`（纯函数分层、`parseKlineLine` 的列序注释）与 `throttle.js`（节制范式）。
- **边界**：只准改 `plugins/com.pet.astock/` 内的 `market.js`、`index.js`、`rules.js`、`widget.js` 与
  `tests/e2e/verify-astock.mjs`。**不得**改 `src/`、`src-tauri/`、`tauri.conf.json`、其他插件目录。
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

## 1.2 待派卡片

### A9 `com.pet.agent-bridge` 改造 —— 配置归插件页 + 多 Agent 单选 + 去掉会话卡片 · 状态：**待排，阻塞于 B2 / B3 / B4**

- **任务**：把「Agent 事件接入」的 UI 与操作全部搬进 agent 桥自己的设置页；页内单选当前联动的 Agent；
  移除头顶那张 overlay 会话卡，改用本体气泡的常驻状态行 + 节点台词。
- **依赖（硬性）**：[HOST-BACKLOG.md](../process/HOST-BACKLOG.md) 的 **B2**（`agent:hooks` 能力 + widget settings 区注入）、
  **B3**（`pet:status` 常驻行）、**B4**（适配器注册表 + `agent_hooks_switch` + 联动状态宿主持久化）**三张全部放行**后才能开工。
  任一张没过就在插件侧凑合实现 = 必然写出错的近似物，评审直接打回。
- **必读**：[../../CONTEXT.md](../../CONTEXT.md)（生命周期四个动作 + 显示三层的定义，本卡的词汇全在那里）、
  [PLUGIN-HANDBOOK.md](PLUGIN-HANDBOOK.md)、[PLUGIN_SDK.md](PLUGIN_SDK.md) §3、
  [adr/0001](../adr/0001-agent-hooks-capability-in-plugin-page.md) / [adr/0002](../adr/0002-single-agent-linkage-uninstall-then-install.md) /
  [adr/0003](../adr/0003-session-visibility-on-pet-bubble.md)、参考实现 `plugins/com.pet.astock/`（纯函数分层 + 串行链的写法）。
- **边界**：只准动 `plugins/com.pet.agent-bridge/`（四个文件）与 `tests/e2e/verify-agent-bridge.mjs`。
  **不得**动 `src/`、`src-tauri/`、`tauri.conf.json`、CSP、其他插件目录、`docs/plugin-dev/PLUGIN_SDK.md`。
  需要宿主再让一步 —— 停下来提出来，不要绕（尤其不要 `import { invoke }` 直连宿主命令，那是 REVIEW §1 的 P0）。
- **manifest 变更**：新增 `agent:hooks`、`pet:status`；**删除 `overlay`**（会话卡去掉后它不再持有任何悬浮窗）；
  `pet:say`/`pet:react`/`bus:subscribe`/`bus:publish`/`storage`/`widget` 保留。逐项核对实际用量：
  声明了没用的要删，用了没声明的激活时会被拒（这是 REVIEW §1 的 P0 检查项）。
- **方案约束（已定）**：
  1. 联动 Agent 的选择器**只显示 `qoder` 可选**；`zcode`/`codex`/`dsh` 作为禁用项列出并注明「接入方式尚未验证」。
     不要在插件侧写任何"猜路径"的逻辑，也不要用 `PET_AGENT_CONFIG_FILES` 糊一个假的可选项。
  2. 装/卸都是**用户显式点按钮**；切 Agent 走 `agent_hooks_switch` 一次调用（事务在宿主侧，插件不要自己串两步）。
  3. 关闭联动 / `deactivate()` → 卸载 hook 的快速路径由插件发起，但要 `await` 在飞的 hook 调用再退出：
     **照 `com.pet.astock/index.js` 的 `overlayChain` 那条教训**排一条串行链，不要用固定 sleep 赌顺序
     （AGENTS.md 记着：后到的 `show` 会把卡重新点亮，`deactivate` 先 `await overlayChain` 再 destroy，同一个坑换个名字再踩一次）。
  4. 显示层：`agent:event` → `setStatus("<状态> · <工具名> · N 步")`（宿主截 60 字，插件侧别再拼长句、别塞 HTML）；
     `needs_input`/`completed`/`failed` 保留 `say()` 台词；`completed` 后 3 秒**清除常驻行**
     （现在那个 `HIDE_AFTER_DONE_MS = 3000` 的语义从"收 overlay"平移成"清常驻行"，别删掉这条时间常量当没需求）。
  5. `widget.js` 的 overlay 区渲染（`mountCard` 那一套标题/状态/步数/工具名）随 `overlay` 权限一起删除，
     不留死代码；badge 区照旧。
  6. 隐私开关 `showTitle`/`showDetail` 留在插件页，且**改一项不能把另一项抹回默认**（`verify:astock` 有这条同类断言，照抄形式）。
- **明确不做**：不接任何新 Agent、不给事件加来源字段、不做多 Agent 并行、不改气泡样式（B3 的地盘）、
  不引入定时器新轮询（插件自己的 `setInterval` 不在宿主回收范围内，必须自己清 —— HANDBOOK §2）。
- **验收**（`verify-agent-bridge` 总数**只增不减**，B2/B3 迁移后的基线是 **50** 条）：
  - 悬浮窗：断言 `overlay_list` 里**不再有** `overlay-com_pet_agent-bridge`，且 HR 心率那张不受影响；
  - **「两扇悬浮窗互不抢占」那组（`:382-409`）改用 `com.pet.hr-ble` + 一个临时探针插件继续跑**，
    不许因为 agent 桥没有 overlay 就把整组删掉 —— 它守的是宿主的按插件分窗机制，不是 agent 桥的功能；
  - 「卡片贴在宠物正上方 / 宽度 ≤360」（`:411-419`）与「游戏模式隐身时卡片一起收/回来」（`:421-425`）
    **改写成气泡断言**（常驻行随宠物窗隐藏、回来仍在），而不是删除；这是 REVIEW §5「断言只许变严」的红线；
  - 常驻行断言：会话进行中 >5 秒文字仍在且含工具名与步数；`completed` 后 3 秒清除；期间 `say` 台词收起不影响常驻行；
  - 生命周期：关闭联动 → 配置文件里 `--pet-hook` 条目归零；重新开启联动 → **不会自动装回来**（用户口径：装要显式点）；
  - 切 Agent：只有 qoder 可选，禁用项点了不产生任何文件改动；
  - 撤销授权确认框两条分支（连带卸载 / 只撤能力）各自断言，且撤能力后再调用 `agent:hooks` 被拒并重新弹同意框；
  - `npm run verify:agent` 全绿 + `npm run verify` ≥ 147（改了本体的话由 B 卡负责，插件侧不得声称）。
- **交付**：git 提交（不 push）、temp 清空、无遗留进程、`verify-agent-bridge` 完整尾部汇总与退出码粘贴、
  `git diff --stat` 证明只动了允许的文件、manifest 最终权限列表原文。

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
| ~~http 响应按 charset 解码（GBK/GB18030）~~ | **已落地并放行**（`341b944`）：`http.rs::decode_body` 认 gbk/gb2312/gb18030，其余保持 lossy | 见 §2.1 B1 的评审结论；下面这张表的其他行仍然成立 |

### 2.1 卡片 B1 `宿主 http 能力` —— 响应按 charset 解码 · 状态：**已放行**（`341b944`，评审 2026-10-09）· 曾是 A8 阶段二的前置（阶段一不等它）
- **任务**：`ctx.http.request` 对非 UTF-8 响应（`charset=GBK` / `GB18030`）返回正确字符串，UTF-8 行为一字不变。
- **任务类型**：**这是本体改动**，§0 模板里「不得改 `src/`、`src-tauri/`」那条边界在本卡片内被下面的白名单覆盖。
  **只准动这些文件**，其余一律不碰：
  - `D:\test\desktop-pet\src-tauri\src\services\http.rs`
  - `D:\test\desktop-pet\src-tauri\Cargo.toml`、`D:\test\desktop-pet\src-tauri\Cargo.lock`
  - `D:\test\desktop-pet\src\runtime\bridge.ts`
  - `D:\test\desktop-pet\docs\plugin-dev\PLUGIN_SDK.md`
  - `D:\test\desktop-pet\scripts\verify.mjs`（或新加 `tests/e2e/verify-http.mjs` + package.json 一条脚本）
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
     插件侧零改动；docs/plugin-dev/PLUGIN_SDK.md 第 68/93 行那两处只补一句「body 按响应 `Content-Type` 的 charset 解码，
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
- **落地后要回改的两处（2026-10-09 已由规划方做完，留此记录口径来源）**：① §1 卡片 A2（天气）里那句「若返回非 UTF-8 编码，宿主 http 目前按 UTF-8 lossy 解码，
  中文会乱 → 换源，不要改本体」已改为「声明 GBK/GB18030 可直接用；宿主认不出的编码仍换源」；
  ② AGENTS.md 的约定区新增两行：charset 解码的边界与「为什么错位比乱码严重」，以及本机对 `push2*` 行情主机的
  TLS 层重置（含换 UA 无效的证据），并同步了 A股插件的数据源描述与 `verify:http` 入口。


## 3. 已定搁置（别自作主张开工）

- **A1–A7 全部候选插件**：用户 2026-10-10 明确"不是我想要的"。详见 §1，不要照卡片开工。
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
`com.pet.todo`（待办）、`com.pet.astock`（A股盯盘：自选+提醒+badge/overlay+分时/K线/五档+出网节制）。
新插件的目录结构、纯函数分层、verify 脚本写法优先照 `com.pet.astock` 与 `com.pet.todo` 抄。

## 5. 评审记录

### B1 + A8 阶段一 评审（2026-10-09）· 结论：**放行**

复验由规划方独立跑，不是转述提交说明：`cargo test --lib` 70 passed；`npm run verify:http` 21 passed；
`npm run verify` 147 passed；`npm run verify:release` 12 passed；`npm run verify:astock` **89 passed / 14 failed**。
边界：两个提交相加只动 `src-tauri/{Cargo.toml,Cargo.lock,services/http.rs}`、`docs/plugin-dev/PLUGIN_SDK.md`、`package.json`
一条脚本、`tests/e2e/verify-http.mjs`、`plugins/com.pet.astock/{index,market,widget}.js`、`tests/e2e/verify-astock.mjs`；
`manifest.json` 与 `src/` 零改动、`bridge.ts` 未动（比卡片要求更保守）、`cargo tree -p tauri` 仍 2.12.0。
`verify-astock.mjs` 断言 69 → 105，**被删除的断言行 0 条**（卡片禁止放宽回归，这条守住了）。

P0 / P1：**无**。

P2（记账，不阻断）
1. **（同日复查中升级为具体缺陷，转阶段二）** 腾讯对**北交所只给当日 1 根 K 线**：
   请求 `param=bj920185,day,,,250,qfq` 实测只回 1 行（`["2026-10-09","21.01","21.82","21.95","20.78","125135"]`），
   键名是 `day` 而不是 `qfqday`。交付的 `tencentSeries()` 已经正确认了 `qfqday → day` 两种键
   （注释里写了「北交所与指数没有复权序列」，实测日期也对），但现有失败判定只挡「0 行」不挡「1 行」——
   所以自选里有北交所标的时，K线面板会画**一根孤零零的当日 K 线**，用户以为历史只有这一天。
   **不是错价，是误导性稀疏**，故仍记 P2，但阶段二必须收掉：解出的 bar 数远小于请求数且东财也不可用时，
   判这个源对该标的「不供历史」并给明确文案，不许拿 1 根充数。
   对照证据（推翻我第一版的推断）：指数 `sh000001` 同样走 `day` 键但**有 10 行历史**、ETF `sz159915` 走 `qfqday` 有 11 行
   —— 所以「`day` 键就等于没有历史」是错的，只有北交所如此；不带 `qfq` 复权参数时腾讯直接只回 `{version}`，
   所以北交所这条必须带着 `qfq` 请求再判行数。
2. ~~分时解析用 `qt.gtimg.cn` 第 5 段取昨收，等于每次刷分时多一条对 GBK 快照接口的请求。~~
   **已撤销**（2026-10-10 复核）：那条请求从来不存在，昨收读的是分时响应自带的 `qt` 段；见下方阶段二评审「已核不成立」第 3 条。
3. 分钟级周期（如 60 分钟）腾讯不供（腾讯源 `klts:[101]`），本机现在这些周期显示错误行 ——
   行为正确（错误里写明「腾讯：不支持该周期」），但界面文案可以更提前告知「分钟线只有东财有」。

疑问（取证不足，不作为问题）
- 阶段一的 failover 断言全部用注入的假 request，没在真机断网验证。卡片就是这么要求的（真断网不可控），
  记在此处只为说明：**它验的是切换逻辑，不是通路可用性**。通路证据在 AGENTS.md 的约定行里。

已核不成立（附证据）
1. **「14 条 `verify:astock` 失败是 A8 引入的回归」——不成立。** 这 14 条全部落在东财专属链上：
   `verify-astock.mjs:193` 要求中文名「贵州茅台」来自东财明细、`:278` 要求交易所给的涨停价（`f51`）、
   `:318` 是 60 分钟线（腾讯 `klts` 不含该周期）、`:391` 面板抬头要求「贵州茅台 + 涨停 + 分时 N 点」——
   而快照/明细/五档在阶段一之后**仍然只有东财一条**。规划方实测 `push2`/`push2his` 整组在约 100ms 内
   `ECONNRESET`（两个不同目标 IP、同一 IP 换 SNI、明文 http 全都被重置），所以这 14 条在本机是**通路红，改动前也会红**。
2. **「快照可以不等 charset 修复，只取 ASCII 数字段就行」——不成立，而且比规划方原判更严重。**
   原判是「30 只常见名称实测无错位，属暂未观察到」；接活者找到了真实命中者：**「硚」的 GBK 编码是 `b3 7e`**，
   尾字节正好是 `~`。lossy 之后它会变成一个真分隔符，让名称之后的每个字段整体挪一位（把今开当现价），
   而到价提醒就建立在现价上 —— 静默错价。该场景已由单测 `gbk_name_with_tilde_trailing_byte_does_not_shift_fields` 钉住。
3. **「把面板三段从并发改成顺序取是顺手扩大范围」——不成立，是必要修复。** 并发时三条链各自先撞一次坏源，
   三笔失败会把整个插件推进 `out()` 的限流冷却，备用源根本轮不到（实测 `trend`/`kline` 直接拿到「限流冷却中」），
   等于 failover 写好了但永远走不到那条路。

**门槛移交**：上述 14 条红就是 A8 阶段二的验收目标 —— 阶段二做完 `verify:astock` 应为 **103 条全绿**。

### A8 阶段二（快照与五档多源 + 两个已知缺陷）评审（2026-10-10）· 结论：**放行**

复验同样由规划方独立跑：`npm run verify:astock` **154 passed / 0 failed**（exit 0，输出落盘后取尾部确认，
不是凭片段宣布）；`npm run verify` **147 passed / 0 failed**。上一轮移交的 14 条红全部转绿，
总量从 105 条涨到 156 条 `check(` 调用（唯一标签 101 → 152）。
边界：只动 `plugins/com.pet.astock/{index,market,widget}.js` 与 `tests/e2e/verify-astock.mjs`，
`manifest.json` 与 `src/`、`src-tauri/` 零改动，`throttle.js` 一字未动；出网点仍只有 `index.js:136`（`out()` 内部）一处。

P0 / P1：**无**。

P2（记账，不阻断）
1. **分钟 K 走 `mkline` 是卡片范围外新增的通道**，但它解决的是上一轮记的 P2 第 3 条（分钟线只有东财），
   且带实测依据（`fqkline` 上的 m1/m5/m15/m30/m60 返回 200 却没有任何数组）与列序单测（各 120 根、开收高低量）。
   与 `fqkline` 同一个 host，所以备用入口与 501 纪律由 `trySource` 的 hosts 循环自然覆盖，不额外扩面。记账认可。
2. 「北交所只回 0~1 根就判不供历史」的阈值取 `<2`，理由（指数/ETF 实测满 120 根、新股真历史可能只有几根）站得住；
   副作用是**刚上市的新股会被说成「不供历史」**，而实际是「腾讯这条通道没给」。界面文案将来值得分这两种说法。
3. 腾讯与新浪对同一收盘时刻的口径差约 40 分钟（腾讯 16:14:57 / 新浪 15:34:59）。
   处理方式正确：时间戳归一成 epoch 毫秒 + `progressOf` 在切源那一轮不判进展、不计入退避。
   这条要留痕到 AGENTS.md（跨源时间戳不可直接比大小），已由规划方补写。

疑问（取证不足，不作为问题）
- `q=` 一次拼 40 只实测 200、URL 381 字符 —— 这只证明了当前规模可用，没探上限。真要加到上百只自选时才需要重新实测。

已核不成立（附证据）
1. **「提交里删了 10 条断言行 = 放宽回归」——不成立。** 逐条按关键词回到新标签：
   「上一次成功的源落盘」从 K线/分时 扩成 K线/分时/五档 + 快照；「第二轮不撞坏源」被更强的
   `记住的源优先：这一轮一次都没撞东财`（断言 `netB.seen` 只有 `proxy.finance.qq.com`）替掉；
   「全部源失败点出每个入口」扩成含两个备用入口与「新浪不供五档」。消失的都是改写，不是删除。
2. **「出网次数从 ≥6 改成 ≥3 是放宽」——不成立。** 计数口径改成「单条链撞一次坏源 + 换源成功」，
   而链数与 kind 数变了；配套的「第二轮一次都没撞东财」是比原来更硬的约束。
3. **「分时每次刷新多一笔 qt.gtimg.cn 的昨收请求」——不成立，这是上一轮评审记录里我自己写错的**（§5 P2 第 2 条）。
   `tencentPrevClose()` 读的是分时/K线响应**自带的 `qt` 段**（响应键 `["day","qt","prec","version"]`），从未单独出网；
   阶段一版本 `98ab2dc` 里也没有那条请求。本轮实际做的是 `index.js:312` 让面板优先用主轮询快照的 `prevClose`、
   内嵌段只作兜底 —— 这是让「平盘基准线」与行情表里的昨收一致，属于正确的额外收益，但不是省出网。
   该 P2 已在上面的记录中撤销。

**交付质量里值得记一笔的两处判断**（不是我要求的，是接活者自己核出来的）：
段位校验没有照卡片写的「段数必须等于 88」硬卡 —— 实测**北交所那行是 87 段**，改成对齐到 48 段；
新浪对不存在的代码回空串，若当成「取数成功、1 条」会把上一轮真价格挤掉，他们做了整行丢弃 + 整批不可用判源失败。

**本轮之后**：A股插件四个 kind（快照/五档/K线/分时）都有多源，本机在东财整组不可达的情况下仍能出数。

