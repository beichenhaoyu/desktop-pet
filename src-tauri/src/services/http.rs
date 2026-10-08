use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

use super::permission::PermissionState;

/// 出站 HTTP 代理。
///
/// 为什么必须由宿主代发：CSP 的 connect-src 只放行 'self' 与 ipc:，插件在 webview 里
/// 直连外域本来就走不通；同时按「插件 × 域名」逐个授权，才不会出现某个插件声明了
/// http 就能访问任意主机（含内网与云元数据端点）。
pub struct HttpState {
    agent: OnceLock<ureq::Agent>,
}

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_BODY_BYTES: usize = 1 << 20; // 1 MiB：防止某个大响应吃掉内存
/// 重定向由我们自己逐跳跟：ureq 自动跟的话只校验首跳域名，
/// 拿到一个已授权域名的插件就能弹到任意主机（内网、169.254.169.254）
const MAX_REDIRECTS: usize = 5;

#[derive(Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
    pub truncated: bool,
}

impl HttpState {
    pub fn new() -> Self {
        Self {
            agent: OnceLock::new(),
        }
    }

    fn agent(&self) -> &ureq::Agent {
        self.agent.get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout_connect(TIMEOUT)
                .timeout_read(TIMEOUT)
                .timeout_write(TIMEOUT)
                // 0 = 不自动跟重定向，3xx 原样返回给 send_following_redirects 逐跳复核域名
                .redirects(0)
                .build()
        })
    }
}

/// 只放行 http/https，并返回小写 host（含端口）作为授权粒度
fn parse_host(url: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(url).map_err(|e| format!("URL 非法: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("只允许 http/https，收到 {other}")),
    }
    parsed
        .host_str()
        .map(|host| match parsed.port_or_known_default() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        })
        .ok_or_else(|| "URL 缺少主机名".to_string())
}

fn host_allowed(granted: &[String], host: &str) -> bool {
    let cap = format!("http:{host}");
    granted.iter().any(|c| c == "http") && granted.iter().any(|c| c == &cap)
}

fn check_granted(
    state: &tauri::State<'_, PermissionState>,
    plugin_id: &str,
    host: &str,
) -> Result<(), String> {
    if host_allowed(&state.granted_caps(plugin_id), host) {
        return Ok(());
    }
    Err(format!("未授权访问 {host}：需要 manifest 声明 http 且已同意该域名"))
}

/// 逐跳发送并校验域名。重定向不再由 ureq 自动跟随：每一跳的新 host 都要重新过一次授权，
/// 换主机时还把 authorization / cookie 摘掉，免得凭据跟着跳转漏给另一个域名。
fn send_following_redirects(
    agent: &ureq::Agent,
    granted: &[String],
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: Option<&str>,
) -> Result<HttpResponse, String> {
    let mut current = tauri::Url::parse(url).map_err(|e| format!("URL 非法: {e}"))?;
    let mut method = method.to_string();
    let mut body = body;
    let mut last_host = String::new();

    for hop in 0..=MAX_REDIRECTS {
        let host = current
            .host_str()
            .map(|h| match current.port_or_known_default() {
                Some(port) => format!("{h}:{port}"),
                None => h.to_string(),
            })
            .ok_or_else(|| "URL 缺少主机名".to_string())?;
        if !host_allowed(granted, &host) {
            return Err(format!("未授权访问 {host}：需要 manifest 声明 http 且已同意该域名"));
        }
        let cross_host = hop > 0 && host != last_host;
        last_host = host;

        let mut req = agent.request(&method, current.as_str());
        for (name, value) in headers {
            if is_valid_header_name(name) && !(cross_host && is_credential_header(name)) {
                req = req.set(name, value);
            }
        }
        let resp = match body {
            Some(text) => req.send_string(text),
            None => req.call(),
        }
        .map_err(|e| format!("请求失败: {e}"))?;

        let status = resp.status();
        if !(300..400).contains(&status) {
            return read_body(resp, status);
        }
        let Some(location) = resp.header("location") else {
            return read_body(resp, status);
        };
        if hop == MAX_REDIRECTS {
            return Err(format!("重定向超过 {MAX_REDIRECTS} 跳，已放弃"));
        }
        current = current
            .join(location)
            .map_err(|e| format!("重定向目标非法: {e}"))?;
        // 303 一律转 GET；301/302 对非 GET 也转 GET（与浏览器一致）；307/308 保留方法与 body
        if status != 307 && status != 308 {
            method = "GET".to_string();
            body = None;
        }
    }
    Err(format!("重定向超过 {MAX_REDIRECTS} 跳，已放弃"))
}

fn is_credential_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "cookie" | "proxy-authorization"
    )
}

fn read_body(resp: ureq::Response, status: u16) -> Result<HttpResponse, String> {
    let content_type = resp.header("content-type").map(str::to_string);
    let mut buf = Vec::new();
    // 多取 1 字节：正好等于上限的合法响应不该被当成超长
    let read = resp
        .into_reader()
        .take(MAX_BODY_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let truncated = read > MAX_BODY_BYTES;
    if truncated {
        buf.truncate(MAX_BODY_BYTES);
    }
    Ok(HttpResponse {
        status,
        content_type,
        body: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    })
}

/// 插件出站请求。host 由 Rust 自己从 URL 解析，不采信前端传来的域名。
#[tauri::command]
pub async fn http_request(
    http: tauri::State<'_, HttpState>,
    perms: tauri::State<'_, PermissionState>,
    plugin_id: String,
    url: String,
    method: Option<String>,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    if !crate::commands::plugins::is_safe_id(&plugin_id) {
        return Err("invalid plugin id".into());
    }
    let host = parse_host(&url)?;
    check_granted(&perms, &plugin_id, &host)?;

    let method = method.unwrap_or_else(|| "GET".into()).to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err(format!("不支持的方法: {method}"));
    }

    // 阻塞线程里拿不到 State，先把这个插件已授权的能力取一份快照带进去
    let granted = perms.granted_caps(&plugin_id);
    let headers = headers.unwrap_or_default();
    let agent = http.agent().clone();
    let sent = tauri::async_runtime::spawn_blocking(move || {
        send_following_redirects(
            &agent,
            &granted,
            &url,
            &method,
            &headers,
            body.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("HTTP 任务失败: {e}"))??;
    Ok(sent)
}

fn is_valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '!' | '#' | '$' | '%' | '&' | '\'' | '*' | '+' | '-' | '.' | '^' | '_' | '`' | '|' | '~'
                )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn granted(caps: &[&str]) -> Vec<String> {
        caps.iter().map(|c| c.to_string()).collect()
    }

    #[test]
    fn http_alone_does_not_allow_any_host() {
        assert!(!host_allowed(&granted(&["http"]), "example.com"));
    }

    #[test]
    fn only_the_granted_host_is_allowed() {
        let g = granted(&["http", "http:api.example.com"]);
        assert!(host_allowed(&g, "api.example.com"));
        assert!(!host_allowed(&g, "evil.example.com"));
        // 端口属于授权粒度
        assert!(!host_allowed(&g, "api.example.com:8443"));
    }

    #[test]
    fn credential_headers_are_recognised_case_insensitively() {
        assert!(is_credential_header("Authorization"));
        assert!(is_credential_header("COOKIE"));
        assert!(is_credential_header("Proxy-Authorization"));
        assert!(!is_credential_header("Content-Type"));
    }
}
