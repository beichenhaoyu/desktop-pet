// 离线单测的 TS 解析钩子（Q3）。让 `node --test` 能直接 import 仓库里的 .ts 源码：
// 1) 无扩展名的相对导入补 .ts（这些文件是按 Vite/bundler 解析写的，不改产品代码去迁就 node）；
// 2) 把 @tauri-apps/api/* 一律指向本地桩，免得离线单件依赖真实 webview。
// 只做解析，不改写任何源码。
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
