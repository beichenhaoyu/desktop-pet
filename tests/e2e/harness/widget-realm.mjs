// L2 阶段二共用的 widget realm 取证（ADR-0008 决策 9）。
//
// 四张迁移卡都用这一份取证，不许各自发明：点名方式、等谁重载、读哪个属性
// 三处一旦分叉，「这个 widget 真的在 Worker 里跑」这句话在两张卡里就不是同一个意思。
//
// realm 从哪读：widget 插槽是 closed shadow root，里面看不见；但壳 `<div data-plugin-id>`
// 在 light DOM 上，宿主建插槽时把 realm 戳在壳的 dataset 上（widget-host.ts 的 createSlot）。
import { waitUntil } from "./cdp.mjs";

/** 默认进 Worker；这份 localStorage 名单是「留在宿主 realm」的例外（与阶段一同向）。 */
export const WIDGET_HOST_REALM_FLAG = "host:widget-realm-plugin-host";

export const setWidgetHostRealm = (c, ids) =>
  c.ev(`localStorage.setItem(${JSON.stringify(WIDGET_HOST_REALM_FLAG)}, ${JSON.stringify(ids.join(","))})`);

export const clearWidgetHostRealm = (c) =>
  c.ev(`localStorage.removeItem(${JSON.stringify(WIDGET_HOST_REALM_FLAG)})`);

/** 读某个 (插件, 区) 插槽现在的 realm；插槽不存在返回 null */
export const widgetRealmOf = (c, pluginId, region) =>
  c.ev(
    `(() => { const n = document.querySelector('div[data-plugin-id=${JSON.stringify(
      pluginId,
    )}][data-region=${JSON.stringify(region)}]'); return n ? (n.dataset.widgetRealm ?? "") : null; })()`,
  );

/** 挂载是异步的（还要等 widget.js 落地），所以取证一律走这条而不是直接读一次 */
export async function waitWidgetRealm(c, pluginId, region, expected, timeoutMs = 20_000) {
  const hit = await waitUntil(
    c,
    `(() => { const n = document.querySelector('div[data-plugin-id=${JSON.stringify(
      pluginId,
    )}][data-region=${JSON.stringify(region)}]'); return n?.dataset.widgetRealm === ${JSON.stringify(
      expected,
    )}; })()`,
    timeoutMs,
  );
  return { ok: hit, actual: await widgetRealmOf(c, pluginId, region).catch(() => null) };
}
