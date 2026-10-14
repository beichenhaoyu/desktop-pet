// A2 / ADR-0007：错误码清单的两侧一致性 + 前端规整函数的行为。
// 口径照 unit-capabilities.mjs（K3）：码表本体只有一份磁盘文件，
// TS 的 const、Rust 的 const、JSON 的 codes 三者对不上就红 —— 改一边，两边都红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  asHostError,
  deniedError,
  ERROR_CODES,
  isHostErrorPayload,
  LEGACY_CODE,
} from "../../src/runtime/host-error.ts";

const JSON_PATH = new URL("../../packages/sdk/error-codes.json", import.meta.url);
const RUST_PATH = new URL("../../src-tauri/src/host_error.rs", import.meta.url);

const catalog = JSON.parse(readFileSync(JSON_PATH, "utf8"));
const rustSrc = readFileSync(RUST_PATH, "utf8");

/** Rust 侧 `pub const X: &str = "code";` 的引用点（顺序 = 声明顺序） */
function rustConstCodes() {
  const out = [];
  for (const m of rustSrc.matchAll(/pub const [A-Z_]+: &str = "([^"]+)";/g)) out.push(m[1]);
  return out;
}

describe("错误码清单的单一来源", () => {
  it("JSON 本体恰好是 ADR-0007 定的 12 个码", () => {
    assert.deepEqual(
      catalog.codes.map((c) => c.code),
      [
        "denied",
        "not-found",
        "invalid-arg",
        "invalid-state",
        "io",
        "network",
        "parse",
        "device-unavailable",
        "scan-start",
        "consent-timeout",
        "unsupported",
        "internal",
      ]
    );
  });

  it("TS 侧 ERROR_CODES 与 JSON 逐字相同（含顺序）", () => {
    assert.deepEqual([...ERROR_CODES], catalog.codes.map((c) => c.code));
  });

  it("Rust 侧 host_error.rs 的 const 与 JSON 逐字相同（含顺序）", () => {
    assert.deepEqual(rustConstCodes(), catalog.codes.map((c) => c.code));
  });

  it("每个码都带 meaning（不许留空说明）", () => {
    for (const c of catalog.codes) {
      assert.ok(typeof c.meaning === "string" && c.meaning.trim().length > 3, `${c.code} 缺说明`);
    }
  });

  it("码的拼法稳定：kebab-case，且没有重复", () => {
    const names = catalog.codes.map((c) => c.code);
    assert.equal(new Set(names).size, names.length, "有重码");
    for (const n of names) assert.match(n, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${n} 不是 kebab-case`);
  });
});

describe("asHostError：两种形状（命令负载 / 框架侧裸字符串）同形", () => {
  it("命令负载 {code,message} → Error.message 逐字不变、code 直取", () => {
    const err = asHostError({ code: "denied", message: "未授权 storage：需要 manifest 声明且已同意" });
    assert.equal(err.message, "未授权 storage：需要 manifest 声明且已同意");
    assert.equal(err.code, "denied");
    assert.equal(err.name, "HostError");
    assert.ok(err instanceof Error);
  });

  it("框架侧的裸字符串 → 文案原样进 message，码记 legacy（不是猜一个）", () => {
    const err = asHostError("只有设置窗可以撤销授权");
    assert.equal(err.message, "只有设置窗可以撤销授权");
    assert.equal(err.code, LEGACY_CODE);
  });

  it("普通 Error 原样通过，只补码；已经带码的不覆盖", () => {
    const plain = asHostError(new Error("boom"));
    assert.equal(plain.message, "boom");
    assert.equal(plain.code, LEGACY_CODE);
    const already = new Error("x");
    already.code = "io";
    assert.equal(asHostError(already).code, "io");
  });

  it("框架侧的裸值（null / undefined / 数字）也不会抛，一律按 legacy 收成字符串", () => {
    for (const v of [null, undefined, 42]) {
      const err = asHostError(v);
      assert.ok(err instanceof Error);
      assert.equal(err.code, LEGACY_CODE);
      assert.equal(err.message, String(v));
    }
  });

  it("形状判定只认两个字符串键，不认「差不多」的对象", () => {
    assert.equal(isHostErrorPayload({ code: "io", message: "x" }), true);
    assert.equal(isHostErrorPayload({ code: "io" }), false, "缺 message 不算");
    assert.equal(isHostErrorPayload({ code: 1, message: "x" }), false, "码不是字符串不算");
    assert.equal(isHostErrorPayload(["denied", "x"]), false, "数组不算");
    assert.equal(isHostErrorPayload(null), false);
  });

  it("桥自己抛的拒绝与宿主 gate 同码（ADR-0007 归一的那条）", () => {
    const err = deniedError("[com.pet.todo] 权限被拒绝: storage");
    assert.equal(err.code, "denied");
    assert.equal(err.message, "[com.pet.todo] 权限被拒绝: storage");
  });

  it("宿主发来表外的码时原样带出，不伪装成表内的码", () => {
    // 这条刻意钉「不美化」：码表是约束而不是过滤器，前端把未知码藏起来会让宿主侧的拼错查不到
    const odd = asHostError({ code: "table-outer", message: "表外的码" });
    assert.equal(odd.code, "table-outer");
    assert.equal(ERROR_CODES.includes(odd.code), false, "表外码不该被误认为表内码");
    assert.equal(asHostError({ code: "network", message: "远端不可达" }).code, "network");
    assert.equal(asHostError("随便什么字符串").code, LEGACY_CODE);
    assert.equal(asHostError(new Error("x")).code, LEGACY_CODE);
  });
});

describe("S3 是拦截门禁，不是只读读数（A2 收口后）", () => {
  it("check:shape 的 S3 与 S1/S2 同级：string_err>0 违例进 why、计入 failing、退出码非 0", () => {
    const tool = readFileSync(fileURLToPath(new URL("../../tools/check-command-shape.mjs", import.meta.url)), "utf8");
    assert.match(tool, /string_err/, "工具里没有 S3 读数");
    // 拦截的机械含义：S3 违例进 why，而 why 汇入 failures、failures 决定退出码 —— 不再只是末尾一个数字
    assert.match(tool, /why\.push\("S3 /, "S3 违例没有进 why —— 那就拦不住任何东西");
    assert.match(tool, /if \(failures\.length > 0\) process\.exitCode = 1/, "退出码没有挂在 failing 上");
  });
});
