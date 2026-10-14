// A2 的进度计量补件：check:shape 的 string_err 只数「已注册的 48 条命令」，
// 而迁移必须连 helper 的签名一起改（否则码在链路中途被 to_string 抹平）。
// 本工具按文件数全 crate 的 Result 错误侧裸 String 签名，供派卡/验收直接比数字。
// 用法：node tools/count-string-err.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'src-tauri', 'src');
const SIG = /Result<[^{}]*,\s*String\s*>/;

const out = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!e.name.endsWith('.rs')) continue;
    const rel = path.relative(SRC, p).split(path.sep).join('/');
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    let n = 0;
    for (const l of lines) {
      if (l.trim().startsWith('//')) continue;
      if (SIG.test(l)) n++;
    }
    if (n) out.push([rel, n]);
  }
})(SRC);

out.sort((a, b) => a[0].localeCompare(b[0]));
const total = out.reduce((a, [, n]) => a + n, 0);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, files: Object.fromEntries(out) }));
} else {
  for (const [f, n] of out) console.log(`  ${f} ${n}`);
  console.log(`RESULT files=${out.length} sigs=${total}`);
}
