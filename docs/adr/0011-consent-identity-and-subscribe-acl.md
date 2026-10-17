# 同意框身份只认磁盘 manifest、topic 订阅侧只认公开名单（2026-10-17 加固）

2026-10-17 对全仓通读评审后落地的 P1/P2 加固（方案见 [优化方案 2026-10-17](../process/OPTIMIZATION-PLAN-2026-10-17.md)）。
其中三条改变了**对外可观察的行为或契约**，所以先写下来。

**决定：**

1. **`permission_request` 不再接受调用方自报的 `plugin_name`**；同意框上显示的名字一律从
   `plugins/<id>/manifest.json` 的 `name` 读（缺字段或类型不对时退回 `id`，
   `commands::plugins::manifest_display_name` 是唯一出口）。
2. **topic 订阅侧收紧**：跨命名空间订阅只认 `PUBLIC_TOPICS`
   （`packages/sdk/topics.js` 导出的冻结名单 = 五条标准 topic ∪ `ble:device-found` /
   `ble:disconnected` / `ble:error`）；**别人插件的私有 topic 一律拒**，不再因为声明了
   `bus:subscribe` 就放行。发布侧规则不动。
3. **`set_click_through` 补上 `gate::pet`**，并把 `let _ =` 吞错改成如实返回 `HostError`。
   它是全项目唯一没有门禁的命令。

同批落地但不构成决策（不改对外契约，只修工程面）：widget boot 加 15s 超时、
`store` 的 per-plugin 锁表改 `Weak` 回收、Worker 侧「不许带进裸 IPC」的判据从手写正则改成
**传递 import 闭包**（`tests/unit/import-graph.mjs`）。

## 为什么第 1 条算决策

同意框是**策略层的边界**本身（AGENTS.md「安全边界共识」：manifest 权限声明 + 能力校验 +
首次授权弹窗）。而「你在给谁授权」这件事以前由调用方传进来：

```
permission_request(pluginId, pluginName, capabilities)   ← pluginName 由前端给
```

绕过 JS 桥直接 `invoke` 的插件可以把这个字段填成任何一个名字。它拦不到「授权被误发」，
但让边界上最重要的一句提示变成不可信 —— 同意的对象正是「这个插件是谁」。
改动的效果是**不可逆的契约变化**：调用方再多传一个 `pluginName` 不会报错（serde 忽略未知字段），
但那份值永远不再被使用。

## 为什么第 2 条算决策

它改变了写进 PLUGIN_SDK 的插件可观察行为：以前「声明了 `bus:subscribe`」等价于
「可读任意命名空间的 topic」，现在等价于「可读自己前缀 + 公开名单」。
这条是被评审点名为「ACL 只防发布不防订阅」的缺口 —— 插件能订到别人的 `:widget`
展示数据（含自选股列表这类内容）。

收紧口径是**白名单**而不是黑名单：新增一条宿主广播 topic 时必须同时登记进 `PUBLIC_TOPICS`，
漏登记的表现是「插件订不到」（当场可见），而不是「默默放开一个别人的私有 topic」。
`tests/unit/unit-sdk-topics.mjs` 反向钉住名单与插件现场字面串的一致性。

## 被否掉的做法

- **给设置窗的命令加「宿主壳凭证」**：同 realm 内不可防 —— 插件代码能 `import` 到宿主壳的模块，
  也能 `listen` 同一个事件。真正能收口只有 Worker 隔离一条路（见下）。
- **保留 `plugin_name` 形参但忽略它**：留一个「看起来还能传身份」的签名面，
  下一个人会以为它有效。签名里不该有这个位置。
- **把订阅 ACL 做成黑名单（拒已知的他人前缀）**：宿主需要另一份「所有插件 id」的实时视图，
  且新增插件时默认放开，方向正好相反。
- **顺手做 `P1-1`（settings 区强制进 Worker）**：改法只有一行，但它会打穿
  `verify-isolation.mjs` 里「agent:hooks 受控能力（settings 区专属）」整组 ——
  那个探针按设计要在宿主 realm 才能把事实写进 `window.__hookProbes`，且它的 manifest 没写
  `apiVersion`。这组断言只能靠桌面 CDP 会话取证，本轮没有；盲改等于留下一套断言过时的套件，
  正是本轮要消灭的那类「假绿」。已拆成待排卡（HOST-BACKLOG 的 P1-1）。

## 已知未收口（不要当作已解决）

- **`settings` 区仍是例外名单唯一能落进宿主 realm 的地方**（`host:widget-realm-plugin-host`）。
  被点名的插件，其设置页代码跑在设置窗 realm 里，而设置窗的门禁只认 `window.label()` ——
  于是它能调 `permission_revoke` / `plugin_enabled_set` / `autostart_set` / `hotkey_set` /
  `pet_skin_*` 这类宿主级命令。默认路（Worker）够不着，但逃生门被点名时够得着。见 P1-1 卡。
- **能力门禁的 `plugin_id` 仍由调用方自报**，同 realm 插件之间分不出（ADR-0006 那条老缺口）。
- `http` 的域名白名单纯按域名判，对 DNS rebinding 无防护；重定向只复核 host 不复核 scheme。
  本轮未动（需要真机与专门的取证设计）。
