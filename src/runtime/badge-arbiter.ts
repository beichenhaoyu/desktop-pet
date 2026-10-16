// 徽标可见性仲裁（ADR-0010 决策 1）：`#widget-badge` 里同一时刻至多一个插槽可见。
//
// 纯模块：不碰 DOM、不读存储、不吃真实时间，也不持计时器 —— 拍子由宿主
// （widget-host.ts 的 5 秒定时器）与全屏事件从外面喂进来，所以离线单测喂假拍子即可。
// 判据是**插槽外壳的布局尺寸非零**（ADR 落地口径第 1 条）：四个自带插件的徽标过去
// 不管有没有数据都画框，从 op 流分不出「有没有内容」，尺寸才是宿主在外面观测得到的信号。
//
// 轮播顺序 = 注入的启用清单数组序（plugin_enabled_list 的原序），不是登记先后 ——
// 登记先后受插件加载竞态影响，数组序才是稳定判据。

/** 轮播每格停留时长（毫秒）。ADR-0010 决策 1 写死 5 秒；定时器只许在 widget-host 侧落。 */
export const BADGE_ROTATE_INTERVAL_MS = 5000;

export interface BadgeArbiterOptions {
  /** 启用清单（数组序 = 轮播序）；给函数则每次重算时现取（启停变化不必重建仲裁器） */
  enabled: readonly string[] | (() => readonly string[]);
}

export interface BadgeArbiter {
  /** 徽标区插槽建出来时登记 */
  register(pluginId: string): void;
  /** 插槽摘除时注销：同时丢掉它的尺寸账（再登记时从零重来） */
  unregister(pluginId: string): void;
  /** 外壳布局尺寸是否非零（ResizeObserver 喂进来的判据） */
  setHasSize(pluginId: string, hasSize: boolean): void;
  /** 全屏期间暂停轮播：tick() 不推进游标；只挡拍子，不改已有可见者 */
  setSuppressed(suppressed: boolean): void;
  /** 一拍：可见者移到候选中的下一个 */
  tick(): void;
  /** 当前应当可见的插件 id；候选为空或当前者失效时为 null（宿主据此整区隐藏） */
  visible(): string | null;
  /** 可见者变化时回调（含变为 null）；返回退订函数。订阅的当下不补发历史，注册首个插槽时会收到初始状态 */
  onChange(fn: (visibleId: string | null) => void): () => void;
}

export function createBadgeArbiter(options: BadgeArbiterOptions): BadgeArbiter {
  const registered = new Set<string>();
  const hasSize = new Map<string, boolean>();
  const listeners = new Set<(visibleId: string | null) => void>();
  /** 当前指到的插件；null = 还没到第一拍。失效（摘除/归零）后保留原值，下一拍从「它之后」续上 */
  let cursorId: string | null = null;
  let suppressed = false;
  /** undefined = 还没通知过：首个插槽登记时也要把「整区无内容」这一次收敛送给宿主 */
  let lastNotified: string | null | undefined;

  const enabledOrder = (): readonly string[] =>
    typeof options.enabled === "function" ? options.enabled() : options.enabled;

  /** 已登记、尺寸非零、且在启用清单里（清单可能有重复项，按出现序去重） */
  function candidates(): string[] {
    const out: string[] = [];
    for (const id of enabledOrder()) {
      if (!registered.has(id) || hasSize.get(id) !== true || out.includes(id)) continue;
      out.push(id);
    }
    return out;
  }

  function currentVisible(): string | null {
    if (cursorId === null) return null;
    return candidates().includes(cursorId) ? cursorId : null;
  }

  function notify(): void {
    const visibleId = currentVisible();
    if (visibleId === lastNotified) return;
    lastNotified = visibleId;
    for (const fn of [...listeners]) fn(visibleId);
  }

  function tick(): void {
    if (suppressed) return;
    const cand = candidates();
    if (cand.length === 0) {
      cursorId = null;
      notify();
      return;
    }
    const at = cursorId === null ? -1 : cand.indexOf(cursorId);
    if (at >= 0) {
      cursorId = cand[(at + 1) % cand.length];
    } else {
      // 光标失效（被摘除 / 尺寸归零）：按启用序从它原本的位置之后续上，找不到就从队首重来
      const order = enabledOrder();
      const pos = cursorId === null ? -1 : order.indexOf(cursorId);
      let next: string | null = null;
      for (let i = pos + 1; i < order.length; i += 1) {
        if (cand.includes(order[i])) {
          next = order[i];
          break;
        }
      }
      cursorId = next ?? cand[0];
    }
    notify();
  }

  return {
    register(pluginId) {
      if (registered.has(pluginId)) return;
      registered.add(pluginId);
      notify();
    },
    unregister(pluginId) {
      if (!registered.delete(pluginId)) return;
      hasSize.delete(pluginId);
      notify();
    },
    setHasSize(pluginId, value) {
      if (!registered.has(pluginId) || hasSize.get(pluginId) === value) return;
      hasSize.set(pluginId, value);
      notify();
    },
    setSuppressed(value) {
      suppressed = value;
    },
    tick,
    visible: currentVisible,
    onChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
