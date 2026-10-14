# 命令错误统一成 `{code, message}`，code 清单只有一份（清单 A2）

清单第 40 项要「HostError（code+message）替代 `Result<_, String>`，前端按 code 分支」，验收是
「无前端字符串匹配错误；verify 不回退」。
**决定：IPC 错误负载改成对象 `{ code, message }`；code 是一份封闭枚举、清单住在 `packages/sdk/error-codes.json`
（能力名单的同款套路，K3 已验证过这个形状）；`message` 文案逐字保持现状；不引入 `thiserror`，手写枚举。**

**为什么算决策**：错误负载的形状是**对外契约** —— 插件的 `try/catch`、设置窗的提示、以及 `tests/e2e` 里
58 条按错误文本判的断言，读的都是它。改成对象的那一刻，所有把这些值当字符串用的地方都会改变行为，
这一步之后不可能"悄悄回滚"，所以必须先写下来。

## 为什么不能一次改完（以及怎么让它可以分批）

`Result<_, String>` 的分布（卡 T09 实测，不是估算）：48 条注册命令里 **42 条的 Err 侧是裸 String**，
Rust 侧非测试代码里 `to_string()` 出现 127 处、错误产生点 **165** 个。一次全改的 diff 面会把
A1 刚收口的命令体重新搅开，而且中间任何一个状态都不可发布 —— 所以迁移必须按域切片，
每片独立可发布。**关键要求：混合态下前端不能崩。** 两条约定保证这点：

1. 前端 `bridge.ts` 把拒绝值规整成 `Error` 并挂上 `code`：字符串形态（未迁移的命令）原样进 `message`、`code` 为
   `"legacy"`；对象形态（已迁移）`code` 直取、`message` 直取。**插件读到的仍是 `err.message`，
   所以未迁移的命令一行都不用改测试**。
2. `verify` 里那 58 条断言**按文本判的先留着不动**，迁移到哪一条就在旁边加一条按 code 判的断言
   —— **只加不减**。等 42 条全部迁完，才允许把文本判据换成 code 判据（那是 A2 的最后一笔，不是第一笔）。

## 不引入 thiserror

清单原文写了 thiserror。`cargo add` 属"要用户开口的动作"（AGENTS.md 与本项目一贯口径：
装依赖会连带抬 tauri 的 minor，历史上真把 `tauri build` 弄红过），而且**这条依赖买不到任何东西**：
手写 `enum HostError` + `code()` + `Display` + `Serialize` 大约 60 行，测试与可读性都不差。
所以：**手写，不加 crate。** 真到要派生 `From<io::Error>` 之类铺满 165 个点时再议，那也不是本项的前提。

## code 清单（封闭枚举，12 个）

`denied`（授权缺失/窗口门禁拒绝，含原 bridge「权限被拒绝」与 gate「未授权…」两套措辞 —— **归一**）、
`not-found`（目标不存在：插件没装、形象没装、悬浮层没装）、
`invalid-arg`（id/slug/rel/topic 等入参不合法）、`invalid-state`（当前状态不允许这个动作）、
`io`（读写文件失败）、`network`（HTTP 与远端不可达）、`parse`（响应或磁盘 JSON 解析失败）、
`device-unavailable`（蓝牙设备不在/没服务/连不上 —— 新加，原来这三类被硬塞进 not-found 与 network）、
`scan-start`（扫描启停这一路的失败）、
`consent-timeout`（同意框超时）、`unsupported`（当前形态做不到）、`internal`（兜底）。

三条纪律：**同一文案跨命令必须同码**（`invalid plugin id` 出现在 8 处，必须是同一个码）；
码一旦发布**不许改名**（要拆细就加新码，把旧的标 deprecated）；
每条码必须有 `tests/unit/unit-error-codes.mjs` 与 cargo 两侧的对账测试 —— 改一边两侧都红，这是 K3 那条纪律的直接复用。

## 进度怎么量（不靠人肉数）

`tools/check-command-shape.mjs` 已经是注册表 + 签名的解析器（ADR-0005）。给它加第三条判据 **S3：Err 侧不是裸 String**，
首跑读数 `string_err=42`。**A2 的完成定义就是 `npm run check:shape` 报 `string_err=0`**，
中间态只报数不拦（S3 先以 `--report` 呈现，最后一笔再升成门禁）。
这样"还剩几域没迁"不是文档承诺，是一条命令的读数。

## 后果

- 未迁移与已迁移的命令在同一份前端代码里共存，这个混合态是**设计出来的**，不是偷懒：
  规整函数上的 `"legacy"` 码就是它的可见标记，等 S3 归零后那条分支连同测试一起删掉。
- astock 插件已经有一个跨层传语义的先例：`err.cooldown` 布尔字段。code 通道**加在 `code` 字段上，
  不动那个布尔**，否则它的冷却逻辑会跟着这次改动一起坏。
- `verify` 的 58 条文本断言在 A2 期间只增不减；A2 收尾那一笔才允许替换判据，
  替换时必须逐条给出「旧标题 → 新标题」的对账表（本波的回退纪律）。
