import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // plugins/ 也在忽略之列：插件 JS 由宿主的 petplugin 协议按磁盘目录提供，
      // 让 Vite 因插件增删而重载页面，只会掩盖「热安装是否真的生效」这件事
      ignored: ["**/src-tauri/**", "**/plugins/**"],
    },
  },
  // 4. 多窗口入口：宠物窗 / 设置窗 / overlay 悬浮层 / 权限同意框
  build: {
    rollupOptions: {
      input: {
        pet: "index.html",
        settings: "settings.html",
        overlay: "overlay.html",
        consent: "consent.html",
      },
    },
  },
}));
