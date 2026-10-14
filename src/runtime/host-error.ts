// A2 / ADR-0007：IPC 错误 `{code, message}` 的 TS 侧唯一入口。
//
// 码表本体在 packages/sdk/error-codes.json —— Rust 侧 host_error.rs 用 include_str! 内嵌**同一份磁盘文件**
// （import 必须带 `with { type: "json" }`，不带会在 node 单测里当场 ERR_IMPORT_ATTRIBUTE_MISSING，K3 实测过这条）。
// 两侧 const 与这份表的一致性由 cargo 单测 + tests/unit/unit-error-codes.mjs 双向钉住。
import catalog from "../../packages/sdk/error-codes.json" with { type: "json" };

/** 码表本体（冻结）。 */
export const ERROR_CODES: readonly string[] = Object.freeze(
  (catalog.codes as { code: string }[]).map((c) => c.code)
);

/**
 * 迁移期的标记：还没改成 `{code, message}` 的命令仍然 reject 一个裸字符串，
 * 规整之后 `code` 就是它。等 `npm run check:shape` 的 `string_err` 归零，
 * 这条连同 `asHostError` 里的字符串分支一起删 —— 它是进度的可见标记，不是长期设计。
 */
export const LEGACY_CODE = "legacy";

/** 宿主错误的可见形状：`Error` 上加一个 `code`，`message` 与迁移前逐字相同。 */
export type CodedError = Error & { code: string };

function define(code: string): string {
  if (!ERROR_CODES.includes(code)) {
    throw new Error(`[host-error] "${code}" 不在码表里 —— 码表是唯一来源，先改 JSON`);
  }
  return code;
}

/** 门禁拒绝：bridge 自己抛的那条「权限被拒绝」与宿主 gate 的「未授权…」归同一码（ADR-0007）。 */
export const DENIED = define("denied");
export const NOT_FOUND = define("not-found");
export const INVALID_ARG = define("invalid-arg");
export const INVALID_STATE = define("invalid-state");
export const IO = define("io");
export const NETWORK = define("network");
export const PARSE = define("parse");
export const DEVICE_UNAVAILABLE = define("device-unavailable");
export const SCAN_START = define("scan-start");
export const CONSENT_TIMEOUT = define("consent-timeout");
export const UNSUPPORTED = define("unsupported");
export const INTERNAL = define("internal");

/** 宿主已经改成 `{code, message}` 的负载形状。判据只看这两个键是不是字符串。 */
export function isHostErrorPayload(value: unknown): value is { code: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { code?: unknown; message?: unknown };
  return typeof v.code === "string" && typeof v.message === "string";
}

/**
 * 把 invoke 的拒绝值规整成 `Error & {code}` —— 未迁移的命令给的是裸字符串，
 * 已迁移的是 `{code, message}`，两种形状下调用方读到的 `message` 都与文案原文一致，
 * 所以 A2 的迁移期间 `tests/e2e` 那批按文本判的断言不需要跟着改（只加不减）。
 */
export function asHostError(rejection: unknown): CodedError {
  if (isHostErrorPayload(rejection)) {
    const err = new Error(rejection.message) as CodedError;
    err.name = "HostError";
    err.code = rejection.code;
    return err;
  }
  if (rejection instanceof Error) {
    // bridge 自己抛的（如权限被拒绝）已有 message；没带码的按 legacy 记。
    const err = rejection as CodedError;
    if (typeof err.code !== "string") err.code = LEGACY_CODE;
    return err;
  }
  const err = new Error(String(rejection)) as CodedError;
  err.name = "HostError";
  err.code = LEGACY_CODE;
  return err;
}

/** 给 `.catch()` 直接用：把拒绝值换成规整后的 Error 再抛出去。 */
export function rethrowAsHostError(rejection: unknown): never {
  throw asHostError(rejection);
}

/**
 * 桥自己判出来的拒绝（没走到宿主就挡下）也带码 —— ADR-0007 要求桥的「权限被拒绝」
 * 与宿主 gate 的「未授权…」归同一码 `denied`，否则前端要按两套措辞分支。
 * 文案一字不改，只是多挂一个 code。
 */
export function deniedError(message: string): CodedError {
  const err = new Error(message) as CodedError;
  err.name = "HostError";
  err.code = DENIED;
  return err;
}
