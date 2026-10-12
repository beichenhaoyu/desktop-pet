// 带 WebView2 远程调试端口启动 dev，供 scripts/verify-isolation.mjs 连接。
import { spawn } from "node:child_process";
import { argv, env, platform } from "node:process";

const port = env.CDP_PORT ?? argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "9223";

const child = spawn("npm", ["run", "tauri", "--", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    // 只杀 npm 包装进程会留下 vite 与 desktop-pet.exe：1420 被占且 strictPort，
    // 下次 dev 直接起不来。按进程树整棵收掉（vite 是 node 子进程，不能按镜像名杀）。
    if (platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
    } else {
      child.kill(sig);
    }
  });
}

child.on("exit", (code) => process.exit(code ?? 0));
