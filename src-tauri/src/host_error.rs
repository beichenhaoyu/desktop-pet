// `consent-timeout` 与 `unsupported` 两个码暂无生产引用点（同意框超时按拒绝收口走 Ok(false)；本轮没有平台限制类 Err）；
// 撤掉这行 allow 会出 3 条 dead_code 警告（2026-10-14 A07 实测，含只被单测引用的 CONSTS），不许为消警告给它们造用法。
#![allow(dead_code)]
//! A2 / [ADR-0007](../../docs/adr/0007-unified-command-error-codes.md)：IPC 错误的唯一形状 `{code, message}`。
//!
//! 码表本体是仓库根的 `packages/sdk/error-codes.json` —— 与 TS 侧
//! `src/runtime/host-error.ts` import 的是**同一个磁盘文件**（TS 必须带 `with { type: "json" }`，
//! 否则 node 单测当场 `ERR_IMPORT_ATTRIBUTE_MISSING`）。这里编译期内嵌（`include_str!`）并解析成静态表：
//! 生产代码引用下面的编译期 const，形状由本文件单测与 `tests/unit/unit-error-codes.mjs` 两侧对撞。
//! 与 `plugin_caps.rs` 同一套套路，不是重新发明 —— 改一边，node 与 cargo 都红。
//!
//! `message` 逐字保持原样（ADR-0007），所以 `tests/e2e` 里按错误文本判的断言不受影响；
//! 命令 Err 侧已全部迁完（2026-10-14 A07 收口，`check:shape` 的 `string_err` 已是拦截项），
//! 前端 `legacy` 码只兜 Tauri 框架自己发出的裸字符串错误（命令名写错、参数序列化失败）。

use std::sync::OnceLock;

use serde::Serialize;

/// 码表本体（编译期内嵌）。**12 个码的唯一定义处**；下面的 const 是编译期引用点。
const CODES_JSON: &str = include_str!("../../packages/sdk/error-codes.json");

/// 授权或窗口门禁拒绝（含原 bridge 的「权限被拒绝」与 gate 的「未授权…」两套措辞 —— 归一并）。
pub const DENIED: &str = "denied";
/// 目标不存在：插件没装、形象没装、悬浮层没装。
pub const NOT_FOUND: &str = "not-found";
/// 入参不合法：id / slug / rel / topic / key 等没过词表或形状检查。
pub const INVALID_ARG: &str = "invalid-arg";
/// 当前状态不允许这个动作：未初始化、已有联动、重复注册。
pub const INVALID_STATE: &str = "invalid-state";
/// 读写文件失败。
pub const IO: &str = "io";
/// 远端不可达或非 2xx。
pub const NETWORK: &str = "network";
/// 磁盘 JSON 或远端响应解析失败。
pub const PARSE: &str = "parse";
/// 蓝牙设备不在 / 没有服务 / 连不上（ADR-0007 新加，原先被硬塞进 not-found 与 network）。
pub const DEVICE_UNAVAILABLE: &str = "device-unavailable";
/// 扫描启停这一路的失败。
pub const SCAN_START: &str = "scan-start";
/// 同意框超时未作答。
pub const CONSENT_TIMEOUT: &str = "consent-timeout";
/// 当前形态做不到。
pub const UNSUPPORTED: &str = "unsupported";
/// 兜底：不属于上面任何一条的宿主内部失败。
pub const INTERNAL: &str = "internal";

/// 命令的 Err 侧。序列化成 `{code, message}`，`Display` 只出 `message` ——
/// 这样按文本取文案的调用方（日志、`tests/e2e` 的断言）拿到的字与迁移前逐字相同。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
}

impl HostError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        // 码不在表里就是手写的拼法（或忘了先改 JSON）—— dev 构建与单测当场炸，不留到线上
        debug_assert!(
            known_codes().iter().any(|c| c == code),
            "不在 error-codes.json 里的错误码: {code}"
        );
        Self {
            code,
            message: message.into(),
        }
    }

    /// io::Error 的统一落点：路径与 os 文案保留在前端可见的 message 里。
    pub fn io(err: std::io::Error) -> Self {
        Self::new(IO, err.to_string())
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HostError {}

impl Serialize for HostError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct as _;
        let mut obj = serializer.serialize_struct("HostError", 2)?;
        obj.serialize_field("code", self.code)?;
        obj.serialize_field("message", &self.message)?;
        obj.end()
    }
}

/// 内嵌码表里登记的码（只做一次）。生产路径靠 `HostError::new` 的 debug_assert 用到它，
/// 所以不是「只给测试看的表」。
pub fn known_codes() -> &'static Vec<String> {
    static CODES: OnceLock<Vec<String>> = OnceLock::new();
    CODES.get_or_init(|| {
        let value: serde_json::Value =
            serde_json::from_str(CODES_JSON).expect("error-codes.json 不是合法 JSON");
        value
            .get("codes")
            .and_then(|c| c.as_array())
            .expect("error-codes.json 里没有 codes 数组")
            .iter()
            .filter_map(|c| c.get("code").and_then(|n| n.as_str()).map(str::to_string))
            .collect()
    })
}

/// 本文件里定义的编译期引用点（顺序与码表一致，便于对差）。
pub const CONSTS: &[&str] = &[
    DENIED,
    NOT_FOUND,
    INVALID_ARG,
    INVALID_STATE,
    IO,
    NETWORK,
    PARSE,
    DEVICE_UNAVAILABLE,
    SCAN_START,
    CONSENT_TIMEOUT,
    UNSUPPORTED,
    INTERNAL,
];

#[cfg(test)]
mod tests {
    use super::*;

    /// 码表与 Rust const 必须逐条相等（顺序也一致）—— 改一边这里就红
    #[test]
    fn codes_match_the_expected_twelve() {
        let expected = [
            "denied",
            "not-found",
            "invalid-arg",
            "invalid-state",
            "io",
            "network",
            "parse",
            "device-unavailable",
            "scan-start",
            "consent-timeout",
            "unsupported",
            "internal",
        ];
        assert_eq!(
            known_codes(),
            &expected.to_vec(),
            "error-codes.json 的码表漂了"
        );
        assert_eq!(
            CONSTS.to_vec(),
            expected.to_vec(),
            "host_error.rs 的 const 漂了"
        );
    }

    #[test]
    fn each_code_has_a_meaning_and_a_stable_shape() {
        let value: serde_json::Value = serde_json::from_str(CODES_JSON).unwrap();
        let codes = value.get("codes").unwrap().as_array().unwrap();
        assert_eq!(codes.len(), 12);
        for c in codes {
            let name = c.get("code").and_then(|v| v.as_str()).unwrap();
            let meaning = c.get("meaning").and_then(|v| v.as_str()).unwrap();
            assert!(!meaning.trim().is_empty(), "{name} 没有说明为什么存在");
            assert!(
                name.chars().all(|ch| ch.is_ascii_lowercase()
                    || ch.is_ascii_digit()
                    || ch == '-'
                    || ch == '_'),
                "{name} 不是 kebab/lower 形状"
            );
        }
    }

    /// 线上形状：前端读到的就是这两个键，没有别的形式
    #[test]
    fn serializes_to_code_and_message() {
        let e = HostError::new(INVALID_ARG, "invalid plugin id");
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            serde_json::json!({ "code": "invalid-arg", "message": "invalid plugin id" })
        );
    }

    /// Display 只出文案：迁移期间「把错误当字符串用」的调用方拿到的字必须与改前一致
    #[test]
    fn display_is_the_message_only() {
        let e = HostError::new(IO, "读取插件存储失败 /x: nope");
        assert_eq!(e.to_string(), "读取插件存储失败 /x: nope");
    }
}
