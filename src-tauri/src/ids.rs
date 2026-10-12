//! 插件 id 的**唯一**校验实现。
//!
//! 原先有三份各写各的：`commands::plugins::is_safe_id`（字符集 + 长度）、
//! `services::permission::valid_id`（只挡 `..` `/` `\`）、`services::store` 里的同款手写检查。
//! 后两份放得过 `C:`、`a b`、`Todo` 这类形态 —— 而 id 同时是插件存储目录名、
//! overlay 窗口标签的来源与授权表的键，口径必须只有一个。
//!
//! 词表与前端 `validateManifest` 的 `/^[a-z0-9][a-z0-9.-]{2,63}$/` 对齐（见下方单测）：
//! 首字符字母数字、其后只允许小写字母/数字/点/连字符，总长 3~64。
//! 这条规则同时是 overlay 窗口标签净化的前提 —— id 里不可能出现 `_`，
//! 所以 `.` → `_` 是可逆编码，`a.b` 与 `a-b` 不会被压成同一个标签。
pub fn is_safe_id(plugin_id: &str) -> bool {
    let bytes = plugin_id.as_bytes();
    if !(3..=64).contains(&bytes.len()) {
        return false;
    }
    let head = bytes[0];
    let ok_head = head.is_ascii_lowercase() || head.is_ascii_digit();
    ok_head
        && bytes[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::is_safe_id;

    #[test]
    fn accepts_the_same_ids_as_the_frontend_rule() {
        for id in ["todo", "zz.probe", "com.pet.hr-ble", "a1.2-3"] {
            assert!(is_safe_id(id), "{id} 应当合法");
        }
    }

    #[test]
    fn rejects_what_the_frontend_rule_rejects() {
        for id in [
            "",       // 空
            "ab",     // 太短（{2,63} 加首字符至少 3）
            "Todo",   // 大写
            "a_b",    // 下划线留给 overlay 标签做转义，不能出现在 id 里
            "../etc", // 路径穿越
            "a/b",    // 分隔符
            r"a\b",
            "a b",        // 空格
            "a:b",        // 窗口标签里合法，但不在 id 词表内
            "C:",         // 盘符：store 那套手写检查以前放得过
            "com.pet./x", // 带分隔符的目录式 id
        ] {
            assert!(!is_safe_id(id), "{id} 应当被拒");
        }
    }

    /// 与前端 `/^[a-z0-9][a-z0-9.-]{2,63}$/` 逐字符对齐：两边判得不一样的 id 就是漏洞
    #[test]
    fn matches_the_frontend_vocab_exactly() {
        let frontend = |id: &str| -> bool {
            let chars: Vec<char> = id.chars().collect();
            match chars.first() {
                None => false,
                Some(&head) => {
                    if !(head.is_ascii_lowercase() || head.is_ascii_digit()) {
                        return false;
                    }
                    if !(3..=64).contains(&chars.len()) {
                        return false;
                    }
                    chars[1..].iter().all(|c| {
                        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-')
                    })
                }
            }
        };
        let mut cases: Vec<String> = vec![
            String::new(),
            "ab".into(),
            "abc".into(),
            "a:b".into(),
            "C:".into(),
            "C:/x".into(),
            "a b".into(),
            "a/b".into(),
            "a\\b".into(),
            "..".into(),
            "../etc".into(),
            "Todo".into(),
            "a_b".into(),
            "-a".into(),
            ".a".into(),
            "1.2-3".into(),
        ];
        cases.push("a".repeat(63));
        cases.push("a".repeat(64));
        cases.push("a".repeat(65));
        for id in cases {
            assert_eq!(is_safe_id(&id), frontend(&id), "id {id:?}：两侧判定不一致");
        }
    }
}
