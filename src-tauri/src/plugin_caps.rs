//! K3：插件能力名的唯一来源（Rust 侧入口）。
//!
//! 名单本体是仓库根的 `packages/sdk/plugin-capabilities.json` —— 与 TS 侧
//! `src/runtime/plugin-capabilities.ts` import 的是**同一个磁盘文件**
//! （TS 必须带 `with { type: "json" }`，否则 node 单测当场 ERR_IMPORT_ATTRIBUTE_MISSING）。
//! 这里编译期内嵌（`include_str!`）并解析成静态表：生产代码引用下面的编译期 const，
//! `http` 域名键的前缀直接消费解析结果。打包版不需要把 JSON 放进 bundle.resources ——
//! 内容都在二进制里。
//!
//! 漂移防线（改名单任何一边，测试即红）：
//!   * 本文件单测：解析结果恰好是既定 12 名；每个 const 都命中名单。
//!   * `tests/unit/unit-capabilities.mjs`：TS 常量集 / 两个门禁文件里的引用 /
//!     八个 Rust 门禁文件里 `crate::plugin_caps::` 的引用 / 四个 manifest 的
//!     permissions，全部对着这份 JSON 对撞。

use std::sync::OnceLock;

/// 名单本体（编译期内嵌）。**12 个名字的唯一定义处**；下面的 const 是编译期引用点，
/// 两者由本文件单测与 node 侧一致性测试逐条对撞。
const CATALOG_JSON: &str = include_str!("../../packages/sdk/plugin-capabilities.json");

/// 能力名的编译期引用点（顺序与 docs/PLUGIN_SDK.md §3 表格一致）。
/// 只有 9 个名字在 Rust 侧有门禁点；`bus:subscribe` / `pet:react` / `pet:say`
/// 只在 webview 内判定（桥 + topic ACL），不在这里 —— 它们的名字仍由名单本体定义。
pub const BUS_PUBLISH: &str = "bus:publish";
pub const STORAGE: &str = "storage";
pub const BLE_SCAN: &str = "ble:scan";
pub const BLE_CONNECT: &str = "ble:connect";
pub const WIDGET: &str = "widget";
pub const OVERLAY: &str = "overlay";
pub const HTTP: &str = "http";
pub const NOTIFY: &str = "notify";
pub const AGENT_HOOKS: &str = "agent:hooks";

struct Catalog {
    names: Vec<String>,
    http_host_prefix: String,
}

/// 首次访问时解析内嵌名单（编译期文件，解析只做一次）。
fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let value: serde_json::Value =
            serde_json::from_str(CATALOG_JSON).expect("plugin-capabilities.json 不是合法 JSON");
        let names = value
            .get("capabilities")
            .and_then(|v| v.as_array())
            .expect("plugin-capabilities.json 缺 capabilities 数组")
            .iter()
            .map(|n| n.as_str().expect("capabilities 项必须是字符串").to_string())
            .collect();
        let http_host_prefix = value
            .get("httpHostPrefix")
            .and_then(|v| v.as_str())
            .expect("plugin-capabilities.json 缺 httpHostPrefix")
            .to_string();
        Catalog {
            names,
            http_host_prefix,
        }
    })
}

/// `http` 域名键的前缀（`http:`）—— 前缀型能力的元信息，来自名单本体。
/// 名单与 const 漂了（比如改了 JSON 没动 const）就在这里炸，而不是静默放出一个
/// 拼法不对的授权键（那样所有 http 请求都会被判未授权）。
pub fn http_host_prefix() -> &'static str {
    let cat = catalog();
    assert!(
        cat.names.iter().any(|n| n == HTTP),
        "名单本体缺 {HTTP} —— plugin-capabilities.json 与 plugin_caps.rs 漂了"
    );
    &cat.http_host_prefix
}

/// `http:<host>` 授权键的拼法（唯一一份）。键不带默认端口：与桥的
/// `new URL(url).host` 对齐，重定向逐跳复核也共用它（见 services::http::host_key）。
pub fn http_host_key(host: &str) -> String {
    format!("{}{host}", http_host_prefix())
}

/// 名单本体（解析结果）。生产路径的消费点是 `commands::plugins::validate_manifest_fields`
/// 与 `declared_capabilities` —— manifest 的 permissions 逐个过 `is_known`（K4 接上），
/// 之前带 `#[cfg(test)]` 的日子结束了。
pub fn all() -> &'static [String] {
    &catalog().names
}

/// 名字是否是名单成员（manifest 校验的成员资格判定，K4 起进生产路径）。
pub fn is_known(name: &str) -> bool {
    all().iter().any(|n| n == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 tests/unit/unit-capabilities.mjs 的 EXPECTED 同源：名单恰好这 12 个名字。
    /// 改 JSON 任何一个名字（哪怕只加一个字符），这里先红。
    const EXPECTED: &[&str] = &[
        "bus:publish",
        "bus:subscribe",
        "storage",
        "ble:scan",
        "ble:connect",
        "widget",
        "overlay",
        "http",
        "notify",
        "pet:react",
        "pet:say",
        "agent:hooks",
    ];

    #[test]
    fn catalog_matches_the_expected_twelve() {
        let mut got: Vec<&str> = all().iter().map(String::as_str).collect();
        let mut want: Vec<&str> = EXPECTED.to_vec();
        got.sort_unstable();
        want.sort_unstable();
        assert_eq!(
            got, want,
            "名单本体与既定 12 名不一致（packages/sdk/plugin-capabilities.json）"
        );
    }

    /// 编译期 const 是名单的引用点：逐条命中名单。改 const 或改 JSON 任一边，这里红。
    #[test]
    fn consts_point_into_the_catalog() {
        let rust_gated = [
            BUS_PUBLISH,
            STORAGE,
            BLE_SCAN,
            BLE_CONNECT,
            WIDGET,
            OVERLAY,
            HTTP,
            NOTIFY,
            AGENT_HOOKS,
        ];
        for c in rust_gated {
            assert!(is_known(c), "const {c} 不在名单本体里");
        }
        // 其余三条只在 webview 内判定（桥 + topic ACL），Rust 侧没有门禁点 —— 如实钉住：
        // 它们必须仍被名单接受，且尚未被收进 rust_gated（将来收了就更新这里）。
        for webview_only in ["bus:subscribe", "pet:react", "pet:say"] {
            assert!(is_known(webview_only), "{webview_only} 必须在名单里");
            assert!(
                !rust_gated.contains(&webview_only),
                "{webview_only} 已有 Rust 门禁，把它补进 rust_gated 列表"
            );
        }
    }

    #[test]
    fn http_prefix_and_key_derive_from_the_catalog() {
        assert_eq!(http_host_prefix(), format!("{HTTP}:"));
        assert_eq!(http_host_key("example.com"), format!("{HTTP}:example.com"));
    }
}
