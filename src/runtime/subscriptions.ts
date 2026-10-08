// 插件经能力桥登记的资源（总线订阅等），插件停用时由宿主统一回收。
//
// 原先全靠插件自己记得调退订函数：漏一次就留下一个仍在收事件的闭包，
// 它捕获的 Shadow DOM 也永远 GC 不掉 —— 而 ctx.bus.subscribe 是异步的（要先过权限），
// 插件把 Promise 当函数 push 进自己的数组、停用时 off() 直接抛错，等于从来没回收过。
// 收口在宿主这边，插件爱怎么早退订都行，但兜底由这里做。
type Cleanup = () => void;

const byPlugin = new Map<string, Set<Cleanup>>();

/** 登记一个回收动作，返回同一个句柄供插件提前自行调用（提前调用后不会再被重复执行） */
export function register(pluginId: string, cleanup: Cleanup): Cleanup {
  let set = byPlugin.get(pluginId);
  if (!set) {
    set = new Set();
    byPlugin.set(pluginId, set);
  }
  const wrapped: Cleanup = () => {
    if (!set.delete(wrapped)) return;
    cleanup();
  };
  set.add(wrapped);
  return wrapped;
}

/** 插件停用时回收它登记的全部资源；返回回收条数（诊断与回归断言用） */
export function disposeAll(pluginId: string): number {
  const set = byPlugin.get(pluginId);
  if (!set) return 0;
  byPlugin.delete(pluginId);
  let done = 0;
  for (const off of [...set]) {
    try {
      off();
      done += 1;
    } catch (err) {
      console.error(`[runtime] 回收 ${pluginId} 的资源失败`, err);
    }
  }
  return done;
}

/** 当前登记的回收条数（只读诊断） */
export function pendingCount(pluginId?: string): number {
  if (pluginId) return byPlugin.get(pluginId)?.size ?? 0;
  let n = 0;
  for (const set of byPlugin.values()) n += set.size;
  return n;
}
