// 解析钩子本体：见 ts-loader.mjs。跑在 loader 线程里，只做解析、不改写源码。
// 规则：@tauri-apps/api/* → 本地桩；*.css / *.svg → 空模块；
// 无扩展名的相对导入按 specifier → specifier.ts → specifier/index.ts 依次试。
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STUB = new URL("./tauri-stub.mjs", import.meta.url).href;
const EMPTY = new URL("./empty-module.mjs", import.meta.url).href;

function isFile(url) {
  try {
    const path = fileURLToPath(url);
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@tauri-apps/api/")) {
    return { url: STUB, shortCircuit: true };
  }
  if (/\.(css|svg|png|webp)$/.test(specifier)) {
    return { url: EMPTY, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const base = new URL(".", context.parentURL);
    for (const candidate of [specifier, `${specifier}.ts`, `${specifier}/index.ts`]) {
      const url = new URL(candidate, base);
      if (isFile(url)) return next(url.href, context);
    }
  }
  return next(specifier, context);
}

// .ts 交给 typescript 自己 transpile，而不是 node 的 strip-only：strip-only 不支持
// 参数属性、enum 这类「会生成代码」的语法，等于让测试运行器的限制反过来约束产品代码。
// typescript 本来就是 devDependency（npm run build 的 tsc 用它），不额外引依赖。
export async function load(url, context, next) {
  if (!url.endsWith(".ts")) return next(url, context);
  const ts = (await import("typescript")).default;
  const { readFile } = await import("node:fs/promises");
  const path = fileURLToPath(url);
  const source = await readFile(path, "utf8");
  const out = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      inlineSourceMap: true,
      inlineSources: true,
      isolatedModules: true,
    },
  });
  return { format: "module", source: out.outputText, shortCircuit: true };
}
