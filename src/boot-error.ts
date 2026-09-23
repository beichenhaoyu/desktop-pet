// 启动兜底错误条。必须是独立模块而非内联脚本 —— 收紧后的 CSP 不允许内联 script。
const el = document.getElementById("err-overlay");

if (el) {
  const show = (msg: string): void => {
    el.textContent = `⚠ ${msg}`;
    el.style.display = "block";
  };
  window.addEventListener("error", (e) => show(e.message));
  window.addEventListener("unhandledrejection", (e) => show(String(e.reason)));
}
