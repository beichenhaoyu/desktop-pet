// tools/check-command-shape.mjs — 命令体形状门禁（优化清单第 39 项 / ADR-0005）
//
// 判据只有两条，都能机械判定，不需要任何人工标注表：
//   S1 命令体不得做直接 IO（文件系统 / 网络原语）——业务数据读写一律在能力域函数里；
//   S2 命令体行数 ≤ 上限（默认 20 行，含空行与注释）——超出的必然在命令体里写了规则，
//      而规则要可测就必须抽成函数（`--report` 会打印每条命令的体行数与违例标记）。
// 注册表来源与解析算法同 src-tauri/src/gate_coverage.rs:64（registered_commands）与
// :79（extract_fn）：命令是否在册由那个 Rust 测试守，这里只管形状。
//
// 输出：每条违例一行 `  - <命令>: <说明>`，末行 `RESULT commands=48 s1=K s2=M string_err=N failing=F`。
//   S3（string_err）是 A2 的进度读数，**只报不拦**：混合迁移期没迁完的域要能继续发布（ADR-0007），
//   归零那天再把它升成第四条门禁。
// 任何一条违例 → process.exitCode = 1（CI 只认退出码）。
// 加 --report 时额外打印全部命令的体行数直方图，供人审，不改变退出码。

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src-tauri", "src");
const MAX_BODY_LINES = 20;

// S1 的关键词：只收「真的会碰磁盘或网络」的原语，注释里的同名词由 stripComments 先清掉
const IO_TOKENS = ["std::fs", "fs::", "File::open", "File::create", "read_to_string", "read_dir", "remove_file", "rename(", "reqwest", "send()", "download_to"];

const posix = (p) => p.split(path.sep).join("/");

function registeredCommands() {
  const lib = fs.readFileSync(path.join(SRC, "lib.rs"), "utf8");
  const marker = "generate_handler![";
  const at = lib.indexOf(marker);
  if (at < 0) throw new Error("lib.rs 里找不到 generate_handler![");
  const body = lib.slice(at + marker.length);
  const end = body.indexOf("])");
  if (end < 0) throw new Error("generate_handler! 没有收尾");
  return body
    .slice(0, end)
    .split(/[\s,]+/)
    .filter((x) => x.includes("::"));
}

// 与 gate_coverage.rs::rs_files 同口径：递归收全部 .rs，跳过 target
function rsFiles(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "target" || e.name === "gen") continue;
      rsFiles(path.join(dir, e.name), out);
    } else if (e.name.endsWith(".rs")) {
      out.push(path.join(dir, e.name));
    }
  }
}

// 与 gate_coverage.rs::extract_fn 同口径：从 `fn 名字(` 起按花括号配对取函数体。
// 不用正则拼签名（`pub`/`async`/换行的组合太多），改成：定位 `fn 名字(` → 跳过注释行 →
// 数参数列表的圆括号到配平 → 从其后第一个 `{` 开始配对花括号。
function extractBody(src, name) {
  const needle = `fn ${name}(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at < 0) return null;
    from = at + needle.length;
    const lineStart = src.lastIndexOf("\n", at - 1) + 1;
    const before = src.slice(lineStart, at).trim();
    if (before.startsWith("//") || before.startsWith("*")) continue;
    // 参数列表配平
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const brace = src.indexOf("{", i + 1);
    if (brace < 0) return null;
    let open = 0;
    let j = brace;
    let inStr = false;
    let inChar = false;
    let inLine = false;
    let inBlock = false;
    for (; j < src.length; j++) {
      const c = src[j];
      const n = src[j + 1];
      if (inLine) {
        if (c === "\n") inLine = false;
        continue;
      }
      if (inBlock) {
        if (c === "*" && n === "/") {
          inBlock = false;
          j++;
        }
        continue;
      }
      if (inStr) {
        if (c === "\\") j++;
        else if (c === '"') inStr = false;
        continue;
      }
      if (inChar) {
        if (c === "\\") j++;
        else if (c === "'") inChar = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "'") inChar = true;
      else if (c === "/" && n === "/") inLine = true;
      else if (c === "/" && n === "*") inBlock = true;
      else if (c === "{") open++;
      else if (c === "}") {
        open--;
        if (open === 0) break;
      }
    }
    const startLine = src.slice(0, lineStart).split("\n").length;
    // signature：从 `fn 名字(` 那行到函数体第一个 `{` 之间的原文，S3 靠它判 Err 侧类型
    return {
      body: src.slice(brace, j + 1),
      signature: src.slice(lineStart, brace),
      startLine,
      endLine: src.slice(0, j).split(/\r?\n/).length,
    };
  }
}

// 只清注释，字符串字面量保留（IO 关键词不会平白出现在注释之外的字符串里，而注释里的同名词必须排除）
function stripComments(code) {
  let out = "";
  let inStr = false;
  let inChar = false;
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (inChar) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === "'") inChar = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "'") {
      inChar = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const files = [];
rsFiles(SRC, files);
const reg = registeredCommands();
const failures = [];
const rows = [];

for (const qualified of reg) {
  const name = qualified.split("::").pop();
  let found = null;
  let file = null;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (src.includes(`fn ${name}(`)) {
      const got = extractBody(src, name);
      if (got) {
        found = got;
        file = posix(path.relative(ROOT, f));
        break;
      }
    }
  }
  if (!found) {
    failures.push(`${qualified}: 在 src/ 里找不到函数体（注册表与代码漂移）`);
    continue;
  }
  const clean = stripComments(found.body);
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "").length;
  const io = IO_TOKENS.filter((t) => clean.includes(t));
  const why = [];
  if (io.length) why.push(`S1 命令体内有 IO 原语: ${io.join(", ")}`);
  if (lines > MAX_BODY_LINES) why.push(`S2 命令体 ${lines} 行 > ${MAX_BODY_LINES}`);
  rows.push({ name, file, lines, why, signature: found.signature });
  for (const w of why) failures.push(`${qualified}（${file}:${found.startLine}）: ${w}`);
}

const s1 = rows.filter((r) => r.why.some((w) => w.startsWith("S1"))).length;
const s2 = rows.filter((r) => r.why.some((w) => w.startsWith("S2"))).length;
// S3：A2 的进度读数 —— Err 侧还是裸 String 的命令数。
// **只报不拦**：混合迁移期（ADR-0007）没迁完的域必须能继续发布，拦在这里等于逼人大改。
// `string_err=0` 那天把它升成第四条门禁，同时删掉 host_error.rs 的 From<HostError> for String
// 与前端那条 legacy 分支。
const STRING_ERR = /Result<[^{}]*?,\s*String\s*>/;
const s3 = rows.filter((r) => STRING_ERR.test(r.signature.replace(/\s+/g, " "))).length;

for (const f of failures) console.log(`  - ${f}`);
if (process.argv.includes("--report")) {
  const sorted = [...rows].sort((a, b) => b.lines - a.lines);
  console.log(
    `REPORT top: ${sorted
      .slice(0, 12)
      .map((r) => `${r.name}=${r.lines}`)
      .join(" ")}`
  );
  console.log(
    `REPORT median=${sorted[Math.floor(sorted.length / 2)].lines} max=${sorted[0].lines} over_limit=${s2} io=${s1} string_err=${s3}`
  );
}
console.log(`RESULT commands=${reg.length} s1=${s1} s2=${s2} string_err=${s3} failing=${failures.length}`);
if (failures.length > 0) process.exitCode = 1;
