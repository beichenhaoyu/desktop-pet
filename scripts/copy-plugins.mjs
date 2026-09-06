// 打包前把 plugins/ 复制进 dist/，使发布版也能通过静态路径动态 import 插件
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const src = resolve(process.cwd(), "plugins");
const dest = resolve(process.cwd(), "dist", "plugins");

if (existsSync(src)) {
  mkdirSync(resolve(process.cwd(), "dist"), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`copied plugins/ -> dist/plugins/`);
} else {
  console.log("no plugins/ directory, skipped");
}
