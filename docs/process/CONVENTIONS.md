# 约定与验收明细

本文件承接 `AGENTS.md` 移出的明细条目：流程与交付、实施步骤、验收标准与套件索引、数据源口径、宿主门禁与安全边界，以及其余长期约定。
移出的原因：`AGENTS.md` 每次会话都要整份进模型上下文，而下面这些条目只在做对应的一类改动时才需要查阅；那里只留索引与硬约束。
搬家规则：条目正文原样搬运、只改实测数字；分组的判据是条目的开头文字，开头对不上任何一组的都留在「其余约定」。

## 流程与交付

- **评审波次（2026-10-08）**：[docs/process/CODE-REVIEW.md](docs/process/CODE-REVIEW.md) 的 45 条已逐条核过并修掉可复现的部分。两条不成立，别再照着"修"：P0 #1（Tauri 2 的 `Window::emit` 走 `manager().emit`，本来就向全部 webview 广播，跨窗总线一直是通的，`verify:todo` 的桌面卡片就是它的运行时证据）；P2 #32（`request()` 里 includes 与优先级判断的先后没有可观察差异 —— 会打断的请求根本不进队列）。

- **协作分工（2026-10-11 起，全项目）**：本会话任**项目经理**——需求拆分、规划、派单、验收；**实现一律交给外部敏捷开发模型**，本会话不接自己的卡（发布/工程类 `S` 卡除外）。四份文档是这条流水线的接口：
  [docs/plugin-dev/PLUGIN-HANDBOOK.md](docs/plugin-dev/PLUGIN-HANDBOOK.md)（接活者的交付标准与坑清单）、
  [docs/plugin-dev/PLUGIN-REVIEW.md](docs/plugin-dev/PLUGIN-REVIEW.md)（评审口径，含「先取证再下结论」与两次误判先例）、
  [docs/plugin-dev/PLUGIN-BACKLOG.md](docs/plugin-dev/PLUGIN-BACKLOG.md)（插件域任务卡、派单模板、需要宿主新能力才能做的提案区、已否决项）、
  [docs/process/HOST-BACKLOG.md](docs/process/HOST-BACKLOG.md)（本体/构建发布/文档域的派单模板、状态板、**验收证据矩阵**：哪类改动必须跑哪个 verify 套件与其断言下限）。
  派单时复制对应 BACKLOG §0 的模板（插件用 PLUGIN-BACKLOG，本体/工程用 HOST-BACKLOG）；
  评审时按 REVIEW §7 的格式输出，「已核不成立」一节必须写，**断言只许变严不许变松**。
  规划方不凭「看起来缺」自行开需求卡，**候选插件 A1–A7 已被用户否决（2026-10-10）**：不要主动提"再加个 XX 插件"，新需求等用户直接提。

- **便携包出到 `release-package/`，不要出到 `dist/`**：`dist/` 是 Vite 的输出目录，任何 `npm run build` / `tauri build`
  都会把它清空 —— 已经因此丢过两次成品包。产物 = `release-package/DesktopPet-<版本>/`（exe + 旁边的 `plugins/` + 更新说明.txt）
  + 同名 zip，`.gitignore` 已覆盖。重出前先核 `src-tauri/target/release/desktop-pet.exe` 的 mtime 晚于
  `src/` 与 `src-tauri/` 的最后一次提交，否则是过期二进制；插件是磁盘加载，改 `plugins/` 不需要重编本体。

## 实施步骤

1. **脚手架 + 宠物窗** ✅
2. **插件运行时** ✅
3. **Rust 能力服务** ✅（store / http 白名单代理 / notify / BLE / 权限同意框均已实现）
4. **三个示例插件**：`heart-rate-ble` ✅、`com.pet.todo` ✅（纯插件、零本体改动）；`llm-token-usage` 暂缓（用户决定）
5. **文档收尾**：[docs/plugin-dev/PLUGIN_SDK.md](docs/plugin-dev/PLUGIN_SDK.md) ✅
6. **桌宠形象改由 Petdex 提供**：九状态图集渲染 ✅ + 设置窗按名字安装 + 默认形象 `deepseek`（本波次）

## 验收标准与套件索引

- `npm run tauri dev` 启动：透明置顶宠物显示并播放 idle 动画，可拖拽，托盘可用 ✅
- plugins/ 目录放入/移除插件后生效 ✅（目录 watcher + 设置窗启停）；单插件异常不崩溃宿主 ✅
- 有应用全屏时宠物自动隐身并停止动画，退出后恢复 ✅（`npm run verify:game` 15 条）。隐身由宿主命令 `set_pet_hidden` 统一负责：宠物窗与贴在它身上的 overlay 悬浮 UI（状态卡、心率波形）一起收放，恢复时按插件当时的意愿重新显示
- 心率插件可扫描/连接并显示实时 BPM ✅；`llm-token-usage` 未做
- 待办插件可增删改勾、桌面卡片、到期提醒，并广播标准 topic `com.pet.todo:changed` ✅（`npm run verify:todo` 30 条）。字段照 todo.txt 约定，数据只存插件自己的隔离存储
- 断开后可直接重连同一设备，不必重新扫描（代码级修复：扫描不再清空句柄缓存，缓存未命中时回落 `adapter.peripherals()`）。**本机无蓝牙硬件，未经真实心率设备验证**
- 设置窗安装 Qoder hook 后，Agent 的工具调用/等确认/结束/失败能驱动宠物 ✅（`npm run verify:agent` 50 条断言）。**已用真实 Qoder 会话验证**：hook 确实被调用、事件按形状落盘并驱动宠物；状态卡贴在宠物头顶显示会话状态、工具名与步数，一轮结束 3 秒后自动收起
- 设置页两级导航：**侧栏只有「宠物设置」+ 插件列表**（一个插件一条），点插件进去是宿主给的壳（启停 / id / 权限 / 撤销授权）+ 插件自己用 `widget.js` 的 `settings` 区渲染的页面；「宠物设置」里收全部非插件配置（形象 / 快捷键 / 自启 / Agent 接入 / 游戏模式）；搜索框过滤的是插件导航项 ✅（`npm run verify` 的「侧栏结构 / 点插件 → 插件页 / 搜索过滤」三组：切页只留一个面板、停用不挂页且说明原因、启用后 widget 挂进来、离开时摘干净）
- 全局快捷键唤出插件页、开机自启 ✅（非法组合键被拒、`CommandOrControl` 这类跨平台 token 可用、改键成功并归一化、自启与快捷键只认设置窗）
- **点击穿透的原点缓存必须跟着窗口走**：`click-through.ts` 用 `tauri://move` 的**载荷位置**刷新原点（不要再回一趟 `outerPosition`，那会在页面重载时制造在飞 IPC），并保留穿透态下的定期重读兜底。系统拖拽会吞掉 `mouseup`，所以 `main.ts` 以「按键已松开」的 mousemove 认定拖完并复位 `dragEngaged` —— 少了这一步，穿透再也不会上开，宠物整块挡鼠标。真鼠标回归见 `temp` 期手工跑过的 SendInput 三步（第一次能拖、拖完仍可点、能连第二次）
- 未授权能力调用被拒绝且触发同意框 ✅；SDK 文档 ✅
- 宠物按 petdex 九状态播放真序列帧（图集 8×9 / 8×11、单元格 192×208）✅（`npm run verify` 的「petdex 图集几何与九状态切片」组）
- 设置窗输入 Petdex 名字（如 `deepseek`）即从公开画廊下载并换装，默认形象 `deepseek`，切换不必重启 ✅（`npm run verify:skin` 26 条：真网络安装 boba、目录穿越被拒、安装类命令只认设置窗、换装后宠物窗不重启就解码新图集、删掉当前形象回落默认）。已用真实截图确认宠物窗里播的就是画廊下载的 deepseek
- 上述大部分由 `npm run verify` 的运行时断言把守（见「约定」），不是靠人工回归

## 数据源口径

- **东财公开接口的三处坑（2026-10-09 实测，改 `market.js` 前先看）**：① `stock/get` 的**五档字段（买 f19/f20…f11/f12、卖 f39/f40…f31/f32）只在省略 `fields` 参数时才返回**，显式点名会被静默丢掉（实测 `fields=f43,f11,f12,f19,f20` 只回 f43）；`f51/f52` 是交易所给的涨/跌停**价**（主板 10%、创业/科创 20%、北交所 920xxx 30%），比按代码前缀猜准，但 ST 拿到的仍是 ±10%。**同一份 `stock/get` 里 `f43`（最新价）与 `f19`/`f39`（买一/卖一）来自不同时刻的聚合**：2026-10-13 盘中对 600519 连采 10 次有 3 次「现价 > 卖一」，越界幅度恰好一个最小变动价位（0.01）—— 所以运行时断言**不许写 `买一 ≤ 现价 ≤ 卖一`**（正确的数据也会随机红），要写成「现价在 `f44/f45` 的当日高低区间内」+「与买一/卖一的越界不超过一个 tick」，后者照样能抓住字段错位。② `kline/get` 的 `klt=102/103`（周K/月K）**实测退化回日K**（内容与 `dktotal` 与 101 完全相同），所以 `KLINE_PERIODS` 里不放周/月；`trends2` 的最后一列是**当日累计均价**，而 `kline` 的同一列是**换手率**，别当同一字段复用。③ 北交所新代码段 `920xxx` 是 9 开头但市场号是 **0**，`secidOf` 里必须排在「9=沪」前面判掉（早先会把 920185 拼成 1.920185 查不到）。
- **腾讯/新浪后端的字段口径（2026-10-09 与 10-10 实测，改 `market.js` 多源那批解析前先看）**：① 腾讯 `qt.gtimg.cn` 一行 88 段、`~` 分隔，**北交所那行是 87 段** —— 段位校验要按「对齐到 48 段」写，别硬卡总数等于 88。`3` 现价 `4` 昨收 `6` 成交量(手) `9..18` 买五 `19..28` 卖五（价/量交替）`47/48` 交易所给的涨/跌停价（沪主板 ±10%、创业板 +20%、北交所 ±30% 三例实测吻合，语义等价东财 `f51/f52`，**不要按代码前缀猜幅度**）；涨跌停不供时是 `-1`，必须落成 `null` 参与比较。**提醒判定（`rules.js`）的封板优先用这个价**：有价按价判（不再依赖 pct 与"顶在最高价"），只有该源不供价（东财批量快照、新浪、-1/0）才回落到 `limitPct` 的前缀表——北交所（92/4/8 开头，口径与 `secidOf` 一致）已在回落表里补成 30%，ST 的 5% 判不出、不假装解决。② 分钟 K 只能走 `kline/mkline`（`fqkline` 上 m1/m5/m15/m30/m60 返回 200 但**没有任何数组**）；日/周 K 走 `fqkline`，且**北交所只回当日 0~1 根** —— 少于 2 根判「该源不供这个标的的历史」，别拿一根冒充历史。③ 分时响应自带 `qt` 段，昨收就地取，没有额外请求；面板优先用主轮询快照的 `prevClose`，让平盘基准线和行情表一致。④ 新浪 `hq.sinajs.cn` 必须带 `referer`，量是**股**（÷100 才等于腾讯的手），**没有涨跌停字段**，且收盘后盘口段被清成 0 —— 所以它只做价格兜底、不供五档。⑤ **跨源时间戳不可直接比大小**：东财是秒 epoch、腾讯是 `YYYYMMDDHHMMSS`、新浪是日期+时间，且腾讯与新浪对同一收盘时刻的措辞能差约 40 分钟。解析层一律归一成 epoch 毫秒，`progressOf` 在切源那一轮不判进展、也不计入退避 —— 否则「换了家源」会被当成价格不动，把退避间隔越拉越长。⑥ 新浪对不存在的代码回空串：整行解不出名字与价格就丢掉，**整批都这样才判源失败**；否则一个坏代码会被当成「取数成功、1 条」，把上一轮的真价格挤掉。
- **插件侧的悬浮窗显隐要排成一条链**（`com.pet.astock/index.js` 的 `overlayChain`）：`show`/`hide` 是 IPC，刚发完一次 `show` 就 `deactivate()` 去 `destroy`，后到的 `show` 会把卡重新点亮 —— 固定 sleep 赌不赢，`verify:astock` 的「停用后卡收掉」就是这么炸的。`deactivate()` 先 `await overlayChain` 再 destroy。
- **A股插件的所有出网必须过 `index.js` 的 `out()`**，不许直接调 `ctx.http.request`。东财这套公开接口没有配额也没有文档，服务端按行为模式识别反爬，`throttle.js` 里那套节制的依据是：① 一次批量快照就把全部自选（≤40 secid）带走，**股票数量不增加请求数**；② 全局最小间隔 350ms + 滚动 60 秒窗口 30 次上限，最坏约 0.4 次/秒、24 次/分钟，比常见反爬阈值低 1–2 个数量级；③ 传输层失败（实测偶发 `fetch failed` / rustls unexpected-eof）在 `out()` 里重试一次，而 **429/403 或连续 3 次失败进 1→5→15→30 分钟阶梯冷却**，冷却期主轮询直接跳过 —— 被拒之后继续按原节奏撞等于把临时限流坐实成长期封禁；④ 行情时间戳连续不前进（休市/停牌/节假日）就按 2 的幂把间隔退避到 30 分钟封顶，有进展立刻恢复，避免 7×24 空转；⑤ 定时器节拍加 ±15% 抖动，不做完美等间隔。**故意不伪装成浏览器 UA**：我们的量不需要伪装，自称 `DesktopPet/0.1` 更容易被判定为正常客户端；真被封了该降频率而不是换马甲。节流状态走 `*:widget` 的 `net` 字段显示在插件页（「近 1 分钟出网 N 次」「限流冷却 Xs」），别让用户看到默默不更新。
- **本机对东财行情主机的通路会漂，不许把「某家源必坏」写进断言（2026-10-09 实测不可达，2026-10-12 实测已恢复）**：`push2` / `push2his` 曾在约 100ms 内 `ECONNRESET`（死在 **TLS ClientHello**，HTTP 请求还没产生，所以换 `user-agent`、补浏览器头、换目标 IP 都无效），而 `www` / `quote` / `emweb.securities` / `searchadapter` / 腾讯 / 新浪 / `baidu` / `petdex.dev` 全通 —— 拦截按 `push2*` 这批主机来；**2026-10-12 同一台机器上 `push2.eastmoney.com` 与 `push2his.eastmoney.com` 已能正常建连**（根路径回 404，说明 TLS+HTTP 通了）。结论：这是分域、随时段变的网络状态，不是代码属性。客户端唯一有效的手段是换源。`verify:astock` 已按 **A11**（2026-10-12）改成**源无关但仍严格**：套件开头做 preflight（逐 host 探可达性，结论用 `r.info` 进报告），各条源断言按「本轮可用性 + 插件回显的失败明细」分支判定（判定层 = `tests/e2e/harness/astock-source-branch.mjs` 纯函数，全通 / 有坏源 / 只有新浪三种形态都有离线单测钉住）；全通时换源或请求数撞满多家照旧判红。改动前先看报告里的 preflight 行确认是哪一类网络状态，别照着「全绿」验收

## 宿主门禁与安全边界

- 跨会话生效的系统级开关一律**只认设置窗**（指的是**设置窗这个 realm**、不再是"只有宿主代码能碰"：`agent:hooks` 已把 hook 配置开给声明了该能力的插件设置页，边界靠 manifest 声明 + 同意框，见 ADR-0001）：`autostart_set`、`hotkey_set`、`hotkey_test`、`permission_list`、`permission_revoke`、`plugin_enabled_set`、`agent_hooks_*`（与 `pet_skin_install/use/remove` 同一套门禁，判定收在 `src-tauri/src/gate.rs`，新增这类命令在那儿加一行即可；命令带可选 `pluginId` 时再加一层能力校验，见 `gate::plugin_capability`）；`settings_show` 反过来只认宠物窗，免得插件页面把设置窗弹来弹去。回归要调这些「只认设置窗」的命令，就用 `tests/e2e/harness/cdp.mjs::openSettingsInvoker` 从设置窗发起，别在宠物窗里指望它放行
- **store / 总线 / overlay 的能力门禁收在 Rust 侧（S1–S3，2026-10-12）**：`store_get/set/delete` 查 `storage`；`bus_publish` 要 `pluginId` + topic 落在 `<pluginId>:` 前缀内 + 已授权 `bus:publish`（`<id>:widget` 认 `widget`），且只有宠物窗 / 设置窗 / 悬浮窗能中继（同意框一类窗口直接拒）；`overlay_show/hide/destroy` 查 `overlay` 且调用窗口必须是宠物窗、设置窗或该插件自己那扇窗（归属由宿主注册表判定）。这三条兜的都是「绕过 JS 桥直接 invoke」——以前只有桥上面挡着，与自述的能力模型不符。**宿主的回收面是分开的**：插件停用走 `overlay_reclaim`（`gate::pet`），撤销授权与孤儿授权回收时 Rust 内部直接收窗，因为那时能力已经没了、走插件面门禁反而留下没人能关的置顶窗
- **插件启停清单归宿主（C1，2026-10-12）**：`<app_data>/plugins-enabled.json` 是唯一事实来源（`services/enabled.rs`，原子写、id 过 `ids.rs` 词表、空表与「还没写过」区分开）。以前它躺在 WebView 的 localStorage 里 —— 清一次 WebView 缓存用户给的启停就全没，而它决定哪些插件被激活。读写分三个命令：`plugin_enabled_list`（任何窗口可读）、`plugin_enabled_set`（只认设置窗）、`plugin_enabled_migrate`（只认宠物窗，且只在文件不存在时写入，返回宿主认定的那份）。运行时每个窗口持一份同步缓存（`loadEnabled()` 取，`getEnabled()` 读），reconcile 每次都向宿主重取。**回归脚本别再写 `host:enabled-plugins`**：用 `tests/e2e/harness/cdp.mjs` 的 `readEnabledIds` / `writeEnabledIds`（写需要设置窗的 invoker）。
- **BLE 命令也查授权表**：`ble_start_scan/stop_scan/connect/disconnect/connected_device` 都收 `pluginId` 并逐项校验 `ble:scan`/`ble:connect`（JS 桥负责传）。以前只有桥上面挡着，绕过桥的插件可以自由扫描连接
- **http 授权键不带默认端口**：宿主算的键必须与桥申请的 `new URL(url).host` 一致。早先用 `port_or_known_default()` 会给 https 凭空补出 `:443`，于是**任何 https 请求都判未授权**；本地测试地址带显式端口（`http://127.0.0.1:9`）两边恰好一致，所以这个错一直藏着 —— 加 https 相关断言时别只用带端口的地址
- **http 按响应 `Content-Type` 的 charset 解码**（`services/http.rs::decode_body`）：只认 `gbk` / `gb2312` / `gb18030` 三个标签（大小写与键名都不敏感，认 `text/html;charset=gbk;` 这种写法），其余一律保持原来的 UTF-8 lossy —— 不猜编码，既有插件不会漂移。腾讯（`charset=GBK`）与新浪（`charset=GB18030`）的实时接口因此才可用。**为什么必须在宿主解**：腾讯行情用 `~` 分段而名称段排在所有数字段之前，GBK 的尾字节允许 `0x7E`（就是 `~`，实测「硚」= `b3 7e`），lossy 之后会变成一个真分隔符，后面每个字段整体挪一位 —— 把「今开」读成「现价」，**静默错价比显示乱码严重**；而字节到 JS 侧已经丢了，救不回来
- **http 的重定向由宿主逐跳跟**：ureq 设 `redirects(0)`，`http.rs::send_following_redirects` 自己走，每一跳的新 host 都要重新过 `http:<host>` 授权（否则授权一个域名就能被 302 弹到内网 / `169.254.169.254`）；跨主机时不带 `authorization`/`cookie`
- **插件身份仍是自报的**：`store_*`、`overlay_*`、`http_request`、`bus_publish` 的 `pluginId` 由调用方给出，能力授权现在都在 Rust 侧查了（见上一条），但同 realm 里插件 A **冒名 B** 仍然拦不住（要等 Web Worker 宿主）。已收紧的两条边角：`overlay_show` 只给确实装着的插件开窗；id 词表在 Rust 侧与前端 `validateManifest` 的字符集对齐
- **插件 id 只有一份校验实现**：`src-tauri/src/ids.rs::is_safe_id`（S4）。原先 `commands::plugins`、`services::permission::valid_id`、`services::store` 各写一套，后两套只挡 `..` `/` `\`，`C:` 这类盘符 id 能过 —— id 同时是存储目录名、overlay 标签来源与授权表键，口径必须唯一。**新增带 `pluginId` 的命令一律走 `gate::plugin_capability`**，漏了会被 `src-tauri/src/gate_coverage.rs` 拦下：它从 `lib.rs` 的 `generate_handler!` 反查全部已注册命令，逐条核对是否过了门禁（只走窗口门禁的例外要写进它的 `WINDOW_GATED` 名单并说明理由）
- Agent watcher 的偏移只在**真的消费掉整行**之后才前进（`complete_line_prefix` 有单测）：以前先写偏移再读，hook 写一半时那批事件永久丢

- **插件样式注入契约暂不收紧**：打包版 CSP 的 `style-src` 保留 `'unsafe-inline'` —— 三个示例插件都用「运行时往自己的 Shadow Root 注入样式表」的写法，且 `tests/e2e/verify-release.mjs` 里有一条断言在替第三方插件作者钉这个契约；真要收紧必须先做 Web Worker 宿主并逐条实测 U-1…U-7。另一类（markup 里的内联 `style=` 属性）已由 M2a 清零，所以这条豁免只覆盖「style 元素」。取舍全文见 [ADR-0004](docs/adr/0004-style-src-unsafe-inline-kept.md)

## 其余约定

- 标准事件 topic：`ble:heart-rate`、`agent:state`（`running｜needs_input｜completed｜idle`，只在变化时广播）、`agent:event`（细粒度 hook 事件：phase / toolName / detail / steps / title，每次工具调用都发）、`llm:token-usage`、`com.pet.todo:changed`
- 宿主窗口事件（不是总线 topic，插件收不到）：`host:fullscreen`（`{active,title}`，最近 3 次采样的多数票）
- Agent 会话状态：`Stop` 之后 2 秒内到达的 pre/post 算迟到事件，不再把会话打回 running（否则卡片会挂着「正在执行」直到 90 秒 TTL 过期）；新一轮的 user-prompt/session-start 立刻作废该宽限期
- topic 归属：`<插件id>:` 前缀归该插件。插件只能**发布**自己前缀；订阅他人/宿主 topic 需声明 `bus:subscribe`，且**不允许通配**越过自己的前缀
- 能力名见 docs/plugin-dev/PLUGIN_SDK.md 第 3 节；新增能力时要同时更新桥、Rust 校验与那份表格
- 共享资源（BLE 会话、BLE 扫描）按插件持有者计数，释放只对真正的持有者生效；overlay 悬浮窗**按插件各开一扇**（标签 `overlay-<id>`，页面按标签认归属），摆放/尺寸/显隐互不影响 —— 早先共用一扇窗导致「后打开的卡片显示不出来」，改成按插件分开后两扇可同时存在
- 插件存储位置：`%APPDATA%/com.desktoppet.pet/plugins/<id>`（插件间隔离，撤销授权会连带清目录）
- 首批插件目录：`plugins/com.pet.hr-ble`（已做）、`plugins/com.pet.agent-bridge`（已做：订阅宿主 `agent:state` 把编码 Agent 的会话状态转成宠物反应）、`plugins/com.pet.todo`（已做：目录名与 id 一致，标准 topic `com.pet.todo:changed` 落在它自己的命名空间里）、`plugins/com.pet.astock`（已做：A股盯盘，出网走宿主 http 代理按域名授权，数据源东方财富公开接口；自选+提醒+badge/overlay，插件页另有分时/K线/五档面板。**2026-10-09 K线与分时已加腾讯后端**：`market.js` 的 `MARKET_SOURCES` 源注册表，每个源一套自己的列序映射（腾讯是「开收高低」，与东财同序不同实现），先试上一次成功的源、一个源内部再主入口→两个后备入口；快照与五档仍只有东财一条，等阶段二。**2026-10-10 阶段二落地**：四个 kind 都有多源，快照/五档为「东财 → 腾讯 `qt.gtimg.cn` → 新浪 `hq.sinajs.cn`」，新浪只兜价格、不供五档与涨跌停）、`plugins/llm-token-usage`（暂缓）
- 面板（分时/K线/五档）只在设置页活着时刷：`PANEL_TTL_MS` 90 秒，由设置页 widget 每 60 秒发一次 `sync` 续期（`watchView(ctx, render, { beatMs })`），badge/overlay 不续期 —— 人走了额外出网要自己停。
- `ctx.bus.subscribe` 这个 API **本身**就要在 manifest 声明 `bus:subscribe`，不声明会在激活时被拒（`com.pet.todo 未在 manifest 声明这些能力: bus:subscribe`）；ACL 放宽的只是「自己前缀不需要额外授权」，别把两者混为一谈
- **验证**：离线常驻单测有八份文件，合计 `npm run unit` = **948 个用例**：`unit:astock`（`tests/unit/unit-market.mjs` 247 + `tests/unit/unit-aux.mjs` 186）、`unit:runtime`（`src/` 运行时纯逻辑 107 条，含 C1 的启停清单迁移，靠 `tests/unit/ts-loader.mjs` 把 .ts 现场转译进 `node --test`，并把 `@tauri-apps/api/*` 换成 `tests/unit/tauri-stub.mjs`）、`unit:plugins`（插件纯函数 53 条，现为 todo-txt；**hr-ble 的 BPM uint8/uint16 解析在 Rust 侧 `ble.rs::parse_heart_rate`，它的单测归 cargo test**）、`unit:astock-views`（插件页分节拆出的纯函数 82 条，M4b）、`unit:capabilities`（能力名单与风险面元数据 159 条，K3/S2）、`unit:manifest-schema` 90 条（K4）、`unit:sdk-topics` 24 条（K2）。**这些条数只会随波次变，验收时读 `npm run unit` 尾部的 `ℹ pass / ℹ fail`，不要拿某个历史数字当常量**（单份文件要单独跑就得带对应的 npm 脚本：`unit:capabilities` / `unit:runtime` / `unit:manifest` 需要 `--import ./tests/unit/ts-loader.mjs`，直接 `node --test` 会得到假的失败）。全部零 GUI、零联网、秒级，用 `import.meta.url` 相对解析被测源码，与 cwd 无关 —— 改 `plugins/` 与 `src/` 的纯逻辑前先跑对应的套件，断言只许增不许减；其余都是 CDP 运行时套件。`npm run dev:debug` + `npm run verify`（WebView2 CDP 驱动真实 webview 的回归断言，覆盖隔离、权限、热安装、渲染几何）；`npm run verify:game` 单跑游戏模式（真起一个铺满显示器的窗口当触发源）；该窗**非置顶、任务栏可见、10~16 秒自关**，PowerShell 每轮检查父进程是否存活，脚本被中断时自己收窗不留孤儿；跑它会抢前台，期间别的置顶程序可能短暂闪动，不要在外面套 `timeout`（2026-09-30 就是「全屏 + TopMost + 每 150ms 注 ALT + timeout 杀父进程」把用户会话压垮过一次）；`npm run verify:agent` 单跑 Agent 桥端到端（脚本直接往 Agent 收件目录写事件，宿主 watcher 负责归一化）；`npm run verify:skin` 单跑桌宠资源安装链路（会真的连 petdex.dev 下载并临时装一个第二形象，跑完自动删掉）；`npm run verify:todo` 单跑待办插件端到端（解析/落盘/广播/桌面卡片/回显，跑完撤销授权并下线）；`npm run verify:astock` 单跑 A股盯盘端到端（会真出网拉行情与盘面数据、弹一次系统通知测试提醒、开一扇左上角盯盘卡、把设置页点到插件页并用 `getImageData` 数画布像素证明图真的画出来了，跑完撤销授权并下线；盘前/竞价时段数据形态不同，断言按「有价才比大小、无价必无量」写成时段无关的形式，**因此它的总条数是形态相关的，判覆盖要比标题集合不要比数字**）；`npm run verify:release` 单独验打包版 CSP，每波次收尾手工跑一次（约 3~4 分钟构建）；`npm run verify:http` 单跑宿主 http 的 charset 解码链路（临时装一个只用来拿能力的探针插件、真出网请求腾讯 GBK 与新浪 GB18030、各弹一次域名同意框并断言授权键不带 `:443`，跑完撤销授权并删探针）。**同一份 dev 实例上连跑多套 CDP 套件时先跑 `verify`**：`verify:astock` / `verify:todo` 这类会撤销授权、关窗并重载文档，跑完后调试端点可能失去响应，后跑的套件会在 `Runtime.evaluate` 上撞 20 秒超时报错（2026-10-13 实测：先 astock 后 verify 连炸两次同一个同意框后的调用，重启实例单跑 `verify` 即 219/0）。这不是被测行为的回归，遇到时重启实例复跑，别去改判据。
- Agent 接入约定：hook 事件由宿主自己收 —— `--pet-hook <phase>` 分支在建窗之前分流，落成 `agent/inbox/<phase>.jsonl`，watcher 读增量并归一化成会话状态后广播。不读 petdex、不开本地端口。phase 必须命中白名单（它同时是文件名与 CLI 参数）；安装/卸载只按 `--pet-hook` 标记增删自己的条目，不动其他 hook，写配置前先备份且原子落盘。
- 状态词表：**只有 petdex 的九个状态** `idle / running-right / running-left / waving / jumping / failed / waiting / running / review`（行号、每行帧数与整行时长见 `src/pet/petdex-states.ts`）。原来的 12 个自造状态（walk/greet/sleep/react/curious/teasing/blush/angry/night）已取消，别再往回加。`ctx.pet.react()` 只认这九个名字，Agent 桥的 phase→状态映射也照搬 petdex 的 `stateForEvent`
- 桌宠资源：磁盘位置只有 Rust `services/skins.rs` 的 skins 目录一个解析点，经 `petskin://<slug>/sprite.webp`（Windows 上即 `http://petskin.localhost/…`）读给 webview；打包版 CSP 的 `img-src` 必须包含 `http://petskin.localhost`，否则只有 `tauri build` 产物会黑屏（dev 不注入 CSP，测不出来）。名字解析走公开接口 `https://petdex.dev/api/manifest/v2`（`pets` 是数组的数组，列序由其 `fields` 给出，别硬编下标）
- overlay 窗口标签把 id 里的 `.` 编码成 `_`（不是 `-`）：id 词表里没有下划线，所以 `a.b` 与 `a-b` 不再抢同一扇窗；回归里的 `overlayLabelFor` 要跟着改
- 运行时的异步生命周期收在三个地方：`plugin-runtime.ts` 每个插件一条串行链（activate/deactivate 排队，弹同意框期间切开关不再产生幽灵激活）、`subscriptions.ts` 由宿主回收插件的总线订阅、`bridge.ts` 缓存会话内已授权的能力并在 `host:permission-revoked` 时失效。插件自己的 `setInterval` 不在回收范围内，仍要自己清
- 插件代码覆盖后免重启：`plugin_file_version` 给出文件 mtime，`pluginFileUrl` 给 `import()` 的 URL 拼 `?v=`（petplugin 协议按 path 找文件，查询串不影响）
- 渲染层不再逐帧烘焙：`SpriteFrame = 源矩形 + 单位化目标矩形`，57 帧共用一份已解码图集（原先 57 张 360×dpr 画布在 dpr=2 时约 118 MB），DPI 变化只需 `fitCanvas` 不必重切片；解码图集缓存按 LRU 限 2 份
- 原子写只有一份实现：`src-tauri/src/fsutil.rs::write_atomic`（tmp 名带 pid），形象 / hook 配置 / 授权表 / 插件存储 / 启停清单都走它，别再复制第六份
- std Mutex 一律 `unwrap_or_else(|p| p.into_inner())`：`panic = "abort"` 下释放版是当场 abort，但 dev 与将来可能的 catch 路径里，锁中毒不该放大成整进程退出
- 加速键字符串必须过 `services/hotkeys.rs::normalize_accel` 再注册：至少一个修饰键、恰好一个主键，`CommandOrControl`/`CmdOrCtrl` 这类跨平台 token 要认（默认值本身就用它写成，不认就会导致「恢复默认」失败）
- 宿主日志：`%LOCALAPPDATA%\com.desktoppet.pet\logs\host.log`
