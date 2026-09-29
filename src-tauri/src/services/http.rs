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

fn check_granted(
    state: &tauri::State<'_, PermissionState>,
    plugin_id: &str,
    host: &str,
) -> Result<(), String> {
    let cap = format!("http:{host}");
    if state.is_granted(plugin_id, "http") && state.is_granted(plugin_id, &cap) {
        return Ok(());
    }
    Err(format!("未授权访问 {host}：需要 manifest 声明 http 且已同意该域名"))
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

    let agent = http.agent().clone();
    let sent = tauri::async_runtime::spawn_blocking(move || {
        let mut req = agent.request(&method, &url);
        for (name, value) in headers.unwrap_or_default() {
            if is_valid_header_name(&name) {
                req = req.set(&name, &value);
            }
        }
        let resp = match body {
            Some(text) => req.send_string(&text),
            None => req.call(),
        }
        .map_err(|e| format!("请求失败: {e}"))?;

        let status = resp.status();
        let content_type = resp.header("content-type").map(str::to_string);
        let mut buf = Vec::new();
        let read = resp
            .into_reader()
            .take(MAX_BODY_BYTES as u64)
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取响应失败: {e}"))?;
        Ok::<_, String>(HttpResponse {
            status,
            content_type,
            body: String::from_utf8_lossy(&buf).into_owned(),
            truncated: read >= MAX_BODY_BYTES,
        })
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
