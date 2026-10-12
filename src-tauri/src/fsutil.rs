//! 宿主侧落盘的公共小工具。
//!
//! 「tmp + pid + rename」这套写法在形象安装、hook 配置、授权表、插件存储里各有一份，
//! 少一处原子性就会留下半截 JSON（下次启动直接当成空表）。统一到这里。
use std::fs;
use std::path::Path;

/// 原子写：先落同目录临时文件再 rename。
/// 临时名带 pid —— 固定名会让两个写入者互相覆盖：
/// 一方还在写 `x.tmp`，另一方已经把同名文件 rename 走了。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {parent:?}: {e}"))?;
    }
    let base = path.file_name().and_then(|s| s.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!("{base}.{}.tmp", std::process::id()));
    if let Err(e) = fs::write(&tmp, bytes) {
        return Err(format!("写入临时文件失败: {e}"));
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("替换文件失败: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("pet-fsutil-{}", std::process::id()));
        let path = dir.join("payload.json");
        write_atomic(&path, b"{\"ok\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"ok\":1}");
        // 只留下目标文件本身
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(vec!["payload.json".to_string()], leftovers);
        let _ = fs::remove_dir_all(&dir);
    }
}
