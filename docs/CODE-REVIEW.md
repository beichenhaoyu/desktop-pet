# 代码评审报告：优化与修复清单

> 评审日期：2026-10-08 ｜ 范围：WebView 前端（src/）、Rust 宿主（src-tauri/src/）、示例插件（plugins/）、回归脚本（scripts/）
> 共 **45 项**：P0 × 9（功能失效 / 安全缺口）、P1 × 18（真实 bug）、P2 × 18（健壮性 / 性能 / 可维护性）

---

## 一、P0 —— 功能失效 / 安全缺口（最优先）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 1 | `src-tauri/src/commands/bus.rs:14` | **跨窗总线实际不通**：`bus_publish` 用 `window.emit` 只投递回本窗，overlay/settings 窗永远收不到其他窗口的总线事件，与注释「广播到全部窗口」相悖 | 改为 `window.app_handle().emit("bus", …)`（发送方去重机制前端已有） |
| 2 | `src-tauri/src/services/http.rs:36-44, 89-90` | **http 授权可被 302 重定向绕过**：只校验首跳 host，ureq 默认跟随 10 次重定向，获准任一域名即可弹到未授权主机（含内网 / `169.254.169.254`） | `AgentBuilder::new().redirects(0)`，或每次重定向后重校 host |
| 3 | `src-tauri/src/services/ble.rs`（全文无 `is_granted`） | **BLE 能力完全绕过授权表**：扫描/连接/断开任何插件可直接调用，与权限模型自述的能力清单不一致 | `ble_start_scan`/`ble_connect` 入口加 `perms.is_granted(&plugin_id, "ble")` |
| 4 | `src-tauri/src/services/permission.rs:307,313` + `store.rs:77-96` + `http.rs:80` + `overlay.rs:181-225` | **插件身份由调用方自报**：插件 A 传 `plugin_id="B"` 即可读写 B 的存储、用 B 的域名授权、销毁 B 的 overlay；`permission_revoke`/`permission_list` 连设置窗门禁都没有，任意插件一行 invoke 可抹掉全部授权并连带清存储 | 短期：`permission_revoke`/`permission_list` 补 `window.label() == "settings"` 门禁；长期：plugin_id 从调用窗口反查（见「重构建议」R2） |
| 5 | `src-tauri/src/services/agent.rs:331-349` | **agent watcher 事件可永久丢失**：`drain_file` 先写偏移量再读文件；读失败或增量中无 `\n`（hook 写一半触发 watcher 的常见情形）时偏移已前进，事件不再被消费——注释声称「半行留给下一次」并不成立 | 读成功并解析出 `end` 后再更新偏移；无换行时保持原偏移 |
| 6 | `src/runtime/plugin-runtime.ts:64-125` | **activate/deactivate 无在途保护**：等用户点同意框期间插件无任何 pending 标记，此时关开关会在「已停用」状态下激活；两个事件源并发触发可致 `mod.activate()` 执行两次 | 每个 pluginId 维护串行化 Promise 链（pending map），activate/deactivate 排入同一链 |
| 7 | `src/runtime/bridge.ts:90-101` | **claim 先于 invoke 且无回滚**：ble startScan/connect 失败时 holders 残留幽灵持有者，导致真正在扫描的插件 release 返回 false——**扫描永远停不下来** | invoke 失败时 catch 里对称 `release` 回滚 |
| 8 | `scripts/verify-game-mode.mjs:97-239`、`verify-agent-bridge.mjs:75-455`、`verify-release.mjs:118` | **异常路径以退出码 0 收场（CI 假绿）**：try/finally 无 catch，`process.exit` 盖掉未决异常；verify-release 内层 finally 在异常路径把 exitCode 改回 0 | 统一补 `catch (err) { r.check("脚本未抛异常", true, false); console.error(err); exitCode = 1; }` |
| 9 | `scripts/verify-game-mode.mjs:7,162` | **清场逻辑整体静默失效**：`readFileSync` 未导入，ReferenceError 被 `catch { continue; }` 吞掉，「不清干净必然假失败」的前置清场从未执行过 | 补导入；catch 里加日志，不再静默 |

---

## 二、P1 —— 真实 bug

### 前端（src/）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 10 | `src/runtime/plugin-runtime.ts:94` + `widget-host.ts:49` | **ESM import 无 cache-busting**：覆盖插件 entry.js 后 URL 恒定命中模块缓存，「目录变动即时生效」对代码变更不成立，必须重启 webview | import URL 拼 `?v=<manifest.version 或 mtime>` |
| 11 | `src/runtime/bridge.ts:77-80` + `event-bus.ts:40-66` | **bus 订阅不随 deactivate 清理**：停用后 handler 继续收事件，闭包持有的 Shadow DOM 无法 GC | bridge 包装 subscribe 按 pid 登记退订函数，deactivatePlugin 统一执行 |
| 12 | `src/runtime/widget-host.ts:85-97` | **mount 在途时 unmount 漏**：mount 未入表 unmount 直接 return，之后记录补进表，孤儿 widget 挂在 DOM 上 | unmount 等待 mounting 中对应 promise，或 mount 收尾前复查是否仍应挂载 |
| 13 | `src/pet/state-machine.ts:148-155` | **兜底皮肤下 onSleep 每帧触发**：waiting 帧缺失回落 idle 后条件持续成立，`say()` 被 60fps 重触发 | 实际切进 waiting 才回调，或加 `afkFired` 标志位 |
| 14 | `src/main.ts:136-141` | **applySkin 并发竞态**：skin-changed 与 dpr change 交错时慢的那次可能把旧皮肤帧盖回新皮肤 | 递增序号或 Promise 链让最后一次调用独占生效 |

### Rust（src-tauri/）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 15 | `src-tauri/src/services/skins.rs:541-545` | **Content-Type 匹配写反**：`Some(("webp", _))` 永不命中（`rsplit_once` 返回 `(前段, 扩展名)`），webp/json 全部落成 octet-stream；正确写法在隔壁 `plugins.rs:140-144` | 改为 `Some((_, "webp"))` / `Some((_, "json"))` |
| 16 | `src-tauri/src/services/ble.rs:88-105` | **notify_pump 早期错误不清连接状态**：找不到特征/subscribe 失败直接 return，`state.connected` 已置 Some 残留，`ble_connected_device` 永久谎报已连接 | 早期返回复用正常退出的代际清理逻辑（或 subscribe 成功后再置 connected） |
| 17 | `src-tauri/src/window/overlay.rs:48-68` | **overlay 标签净化碰撞**：`a.b` 与 `a-b` 映射成同一标签，`owner_of_label` 按 HashMap 迭代序取第一个，归属张冠李戴 | overlay_show 时校验标签唯一性拒绝碰撞，或把 `.` 编码为可区分序列 |
| 18 | `src-tauri/src/window/pet.rs:37-39` | **`quit_app` 无任何门禁**：任何窗口（含插件 JS）可退出整个应用；托盘实际走 `app.exit(0)` 并不需要这条命令 | 加窗口门禁或直接删除该命令 |
| 19 | `src-tauri/src/services/store.rs:83-96` | **store 读-改-写无并发保护**：两个窗口并发写同一插件时后写覆盖先写，静默丢键 | 按 plugin_id 加进程内写锁 |

### 插件（plugins/）

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 20 | `plugins/todo/index.js:74-79, 179` | **checkDue 先标记已提醒后 await 通知**：通知抛错则该任务今天漏提醒且循环中断，rejection 成为未处理异常 | 循环体包 try/catch，三个 await 全部成功后再写 `notified[task.id]` |
| 21 | `plugins/com.pet.hr-ble/widget.js:313,327` | **`selectedName` 声明后从未赋值**：select 无 change 监听，连接状态/回显/持久化里的设备名恒为 null | 给 devicesSel 加 change 监听取 `selectedOptions[0]?.textContent` |
| 22 | `plugins/com.pet.hr-ble/index.js:113-118` | **意外掉线无重连路径**：手环短暂离 range 后必须手动回设置窗重连 | 掉线时若 `config.device` 非空，按指数退避排几次重连 |
| 23 | `plugins/com.pet.hr-ble/index.js:125` | **启动重连的 setTimeout 未纳入 deactivate 清理**：800ms 内 deactivate 时定时器仍会触发（靠 try/catch 兜住） | 保存 timer id，deactivate 里 `clearTimeout` |
| 24 | `plugins/com.pet.hr-ble/widget.js:257-261` | **chart 分支不校验 bpm**：一个 NaN 进 history 后 min/max 全变 NaN，波形要再攒 60 个有效点才自愈 | chart 订阅回调开头 `if (!Number.isFinite(bpm)) return;` |
| 25 | `plugins/todo/index.js:179` | **activate 无重入保护**：重复激活叠 interval（agent-bridge 有 `stop()` 防重入，todo 没有） | activate 开头 `if (timer) clearInterval(timer)` |
| 26 | `plugins/todo/index.js:166-168` | **config 恢复无字段白名单/类型校验**：接受存储里任意类型；hr-ble/agent-bridge 都是逐字段严格校验，todo 不一致 | 改为显式恢复：`card: saved.card === true, remind: saved.remind !== false` |
| 27 | `plugins/todo/todo-txt.js:75-88` + `index.js:48` | **nextDue 可能不是最近到期**：未来任务 rank 相同且不按日期排序，订阅方拿到错误的「下一个到期」 | rank 相同时按 `meta.due` 字典序二次排序 |

---

## 三、P2 —— 健壮性 / 性能 / 可维护性

### 性能与内存

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 28 | `src/pet/sprites.ts:84-97` | **全量帧按 dpr 烘焙内存被低估**：57 帧 × 360×dpr 画布，dpr=2 约 118MB backing store；源图集只有一份，drawImage 可直接带源矩形切片 | 保留单份图集 + 每帧按 (col,row) 切片绘制，烘焙只留兜底路径 |
| 29 | `src/pet/sprites.ts:36` | **atlasCache 无上限**：每换一次皮肤驻留一张解码图集（约 12MB），无失效路径 | 换肤时 clear 或限容 LRU |
| 30 | `src/runtime/bridge.ts:48-59` | **gated 每次调用一次 permission_check IPC**：ble 心率驱动的插件每秒多次 Rust 往返，授权状态会话内基本不变 | ctx 构建后缓存已授权能力集，撤销授权时失效 |

### 前端小问题

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 31 | `src/pet/sprites.ts:24, 44-45` | bakeScale 是模块级可变全局，并发 loadSpriteSet 互相污染 | scale 改为显式参数传入 sliceAtlas/scaleToFrame |
| 32 | `src/pet/state-machine.ts:87-92` | includes 检查先于优先级判断，低优先级期排队的动作之后无法打断 | includes 判断移到优先级比较之后 |
| 33 | `src/settings/main.ts:155` | 启用计数包含已卸载插件（如显示 "3/2"） | 与 manifests 求交集后再计数 |
| 34 | `src/runtime/bridge.ts:130` | 报错文案语义反了（"需要非文本内容"实为"内容为空"） | 改为「say 需要非空文本内容」 |
| 35 | `src/consent/main.ts:15` | consent_details 失败无兜底：空白同意框 + 宿主侧申请永远挂起 | try/catch 后窗内显示错误并自动 `consent_answer(false)` |

### Rust 健壮性

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 36 | `Cargo.toml`（`panic = "abort"`）+ 全库数十处 `Mutex::lock().unwrap()` | 持锁期间任何 panic 毒化锁，下一个 unwrap 直接 abort 整进程（fullscreen.rs:71-74 的 `.lock().ok()` 说明作者知道但没贯彻） | 统一 `.lock().unwrap_or_else(|p| p.into_inner())` 或换 parking_lot |
| 37 | `src-tauri/src/window/tray.rs:15` | `.expect("missing default window icon")` 可致启动即崩 | 图标缺失时返回 Err 或跳过 `.icon()` |
| 38 | `src-tauri/src/services/hotkeys.rs:160` | hotkey_test 对「当前生效但未落盘的默认键」误报冲突 | 与 `read_saved(&app).unwrap_or(DEFAULT_ACCEL)` 比较 |
| 39 | `src-tauri/src/services/ble.rs:183-199` | 扫描循环持 core 锁跨多个 await（每台新设备一次 WinRT 往返），连接路径全部排队 | 锁内只取列表，属性查询移到锁外再写回 |
| 40 | `src-tauri/src/services/skins.rs:317`、`http.rs:123` | get_bytes 大小上限差一：恰好等于上限的合法响应被拒 | `take(max + 1)` 后以 `> max` 判定 |
| 41 | `src-tauri/src/services/skins.rs:514,537`、`commands/plugins.rs:113,173` | 每协议请求 spawn 一条新线程 + 图集 body 整份 clone（可达 12MB） | `async_runtime::spawn` + `spawn_blocking`；`body.unwrap_or_default()`（状态码先行记录） |

### 脚本

| # | 位置 | 问题 | 修复 |
|---|---|---|---|
| 42 | `scripts/verify-isolation.mjs:273` | 「按拒绝处理」弱断言：错误/超时也能通过 | 改为断言 `raced.v === false` |
| 43 | `scripts/verify-isolation.mjs:13`、`verify-agent-bridge.mjs:17`、`verify-game-mode.mjs:13` | APPDATA 缺失时静默降级成错误路径（相对路径落 cwd 或拼出 `undefined\...`） | 开头统一 `if (!env.APPDATA) process.exit(2)` |
| 44 | `scripts/verify-agent-bridge.mjs:466` | 恢复启用清单时把用户原本启用的 agent-bridge 也摘掉了（verify-todo 是原样恢复，行为不一致） | 恢复原值；只在原本不在清单里时才 deactivate |
| 45 | `scripts/gh-auth.cmd:7` | gh.exe 路径硬编码 | `where gh` 探测或依赖 PATH |

---

## 四、重构建议（接受重构时的系统性改造）

- **R1｜统一 `write_atomic` 工具模块**：同套「tmp+pid+rename」逻辑在 `skins.rs:243`、`agent_hooks.rs:192`、`store.rs:62`、`permission.rs:77` 重复四份（permission 版还丢了 pid）。提取到 `util` 模块统一维护。
- **R2｜插件身份绑定（长期架构项）**：`plugin_id` 由前端参数自报是 P0#4 的根因。参照 `overlay_owner` 的反查机制，从调用窗口解析插件身份而非采信参数；这与路线图上 Web Worker 宿主收口「同 realm import invoke 绕过」是同一方向，可一并设计。
- **R3｜生命周期并发原语**：activate/deactivate/mount 三条异步生命周期统一引入 per-id Promise 链（一次性解决 P0#6、P1#10、P1#12 三个竞态），并在 ctx 层集中管理订阅/定时器登记，deactivate 兜底回收（解决 P1#11、P1#23、P1#25 一类「靠插件自觉」的问题）。
- **R4｜门禁有效性分层**：`window.label()` 门禁对 pet 窗内插件无效（插件 JS 就跑在 pet 窗，可 `set_pet_hidden`、打开设置窗）。敏感命令需区分「宿主 UI 调用」与「插件调用」（bus 来源标记或独立插件 invoke 通道）。
- **R5｜渲染内存策略重算**：按 P2#28 改为「单份图集 + 每帧切片绘制」，同时解决 atlasCache 无界问题，换装只换引用不换缓存。

## 五、建议修复路线

| 波次 | 内容 | 验证 |
|---|---|---|
| **第 1 波**（安全与总线，~1 天） | P0 #1–#5 | `npm run verify` 全量 + 补重定向/冒用 plugin_id 的断言 |
| **第 2 波**（生命周期竞态，~1-2 天） | P0 #6–#7 + R3（顺带带走 P1 #10–#12、#23、#25、#30） | verify 全量 + 热插拔反复切换手工冒烟 |
| **第 3 波**（插件与脚本，~1 天） | P0 #8–#9、P1 #20–#27、P2 #42–#45 | `verify:todo` / `verify:agent` / `verify:game` 逐个绿 |
| **第 4 波**（健壮性与性能，~2 天） | P1 #15–#19、P2 #28–#41、R1/R4/R5 | verify 全量 + `verify:release` + 内存前后对比 |

每波次收尾按项目约定跑一次 `npm run verify`，改动 CSP 或打包相关时加跑 `npm run verify:release`。

---

## 六、整体评价

**前端**：分层清晰（pet / runtime / 各窗口入口职责分明），状态词表、图集规格、URL 解析收敛到单一模块；安全模型定位诚实，textContent 建 DOM 的习惯贯彻得好；共享资源持有者计数是同类项目少见的严谨设计。短板集中在异步生命周期并发收口，使「热插拔即时生效」这个核心卖点在真实操作序列下不可靠。

**Rust 宿主**：「注释即设计文档」，纯函数抽离配了扎实单测，错误处理口径统一。短板有二：插件身份不可信的前提在命令层没贯彻（自报 plugin_id、ble 漏授权表、window.emit 误用），使策略层比自述的信任模型更薄；`panic = "abort"` 与遍布的 `lock().unwrap()` 组合把锁中毒放大成整进程退出。

**插件与脚本**：插件质量明显高于脚本——清理路径、隐私分层、XSS 防护都有意识且到位，manifest 与实际能力全部相符。脚本共性问题是**异常路径下退出码的诚实性**，三个 verify 脚本都可能在崩溃时以 0 退出，对回归工具这是比断言失败更危险的失效模式。

总体高于平均水准。修掉 P0 九条（尤其 bus emit 与 http 重定向）+ 补齐生命周期并发原语后，完成度会相当高。
