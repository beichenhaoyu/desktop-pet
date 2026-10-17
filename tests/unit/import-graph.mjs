// 传递 import 闭包（P2-5）。
//
// 为什么要有这个文件：ADR-0006 / ADR-0008 的隔离前提是「Worker 侧的 bundle 里不许躺着
// 真正的 IPC 入口」，而原来守这条的是两个手写正则 —— 只认双引号、只看**直接** import。
// 于是改成单引号，或者中间过一层 re-export，判据就看不见了。这里换成真的把 import 图走一遍：
// 用 TypeScript 的解析器取说明符（与引号风格、与 `import(typeof)` 写法无关），
// 递归相对导入，直到闭包不动；命中的外部包与文件如实回报。
//
// 只做解析与递归，不改写任何源码，也不执行被测模块。
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** 相对说明符的候选后缀：`.ts` 优先（本仓源码是 TS），构造物与 JS 兜底 */
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", ".js", "/index.js"];

/** 能进解析器的后缀；其它（.json / .css / .svg）只记进闭包，不当模块解析 */
const PARSABLE = /\.(ts|tsx|mts|js|mjs|cjs)$/;

const toPath = (entry) => (typeof entry === "string" ? resolve(entry) : fileURLToPath(entry));

/**
 * 一个模块里出现的所有模块说明符：静态 import / export ... from / import x = require /
 * 动态 `import("…")`。走 AST，所以注释里提到 `@tauri-apps` 不会被误判成违规。
 */
function specifiersOf(file) {
  const source = readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, kind);
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) out.push(spec.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      out.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 相对说明符 → 磁盘文件；解不出（如类型包目录只有 index.d.ts）返回 null */
function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * 从若干入口出发的传递闭包。
 * - `files`：闭包内所有磁盘文件（绝对路径，已排序）
 * - `external`：闭包内出现过的非相对说明符 → 第一个引用它的文件
 * 入口文件自己也算一个；解不出的相对说明符（纯类型 import、`?worker` 之类）**不**进闭包，
 * 因为我们能判的只有磁盘上真实存在的模块。
 */
export function importClosure(entries) {
  const files = new Set();
  const external = new Map();
  const roots = (Array.isArray(entries) ? entries : [entries]).map(toPath);
  for (const entry of roots) {
    if (!existsSync(entry)) throw new Error(`import 闭包的入口不存在: ${entry}`);
  }
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!PARSABLE.test(file)) continue;
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const next = resolveRelative(file, spec);
        if (next) queue.push(next);
      } else if (!external.has(spec)) {
        external.set(spec, file);
      }
    }
  }
  return { files: [...files].sort(), external };
}

/**
 * 按判据分类回报，供断言直接用：
 * - `tauri`：闭包里出现的 `@tauri-apps*` 说明符
 * - `hostErrorFiles`：闭包内 basename 为 host-error 的文件（IPC 入口的同义词）
 */
export function inspect(entries) {
  const { files, external } = importClosure(entries);
  return {
    files,
    external,
    tauri: [...external.keys()].filter((spec) => spec.startsWith("@tauri-apps")).sort(),
    hostErrorFiles: files.filter((file) => /(^|[\\/])host-error\.(ts|tsx|js|mjs)$/.test(file)),
  };
}
