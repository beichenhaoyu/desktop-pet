// 心率蓝牙插件（主逻辑，运行于宠物窗上下文）
// 数据流：Rust ble:heart-rate → 本插件整理 → `${PID}:bpm` 总线 → 各窗口 widget 渲染
// 设置面板（设置窗）通过 `${PID}:cmd` 下发指令，本插件执行并回发状态。
// 悬浮窗只在「波形图模式 + 已连接设备」时显示，断开即自动关闭。
import { PID, TOPIC_BPM, TOPIC_CMD, TOPIC_DEVICES, TOPIC_STATUS } from "./topics.js";

let ctx = null;
let config = { device: null, deviceName: null, mode: "badge" };
let connected = false;
const unsubs = [];

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

async function persist() {
  try {
    await ctx.storage.set("config", config);
  } catch (err) {
    ctx.log("保存配置失败", err);
  }
}

/** 悬浮窗显隐与「模式 + 连接状态」联动 */
async function syncOverlay() {
  if (config.mode === "overlay" && connected) {
    await ctx.overlay.show();
  } else {
    await ctx.overlay.hide();
  }
}

async function handleCmd(cmd) {
  try {
    switch (cmd.action) {
      case "scan": {
        await ctx.ble.startScan();
        status("正在扫描蓝牙设备…（打开手环的心率广播）");
        break;
      }
      case "connect": {
        await ctx.ble.connect(cmd.deviceId);
        config.device = cmd.deviceId;
        config.deviceName = cmd.deviceName ?? null;
        connected = true;
        await persist();
        await syncOverlay();
        status(`已连接 ${config.deviceName ?? cmd.deviceId}`, "ok");
        break;
      }
      case "disconnect": {
        await ctx.ble.disconnect();
        config.device = null;
        config.deviceName = null;
        connected = false;
        await persist();
        await syncOverlay(); // 断开即自动关闭悬浮窗
        status("已断开连接");
        break;
      }
      case "mode": {
        config.mode = cmd.value === "overlay" ? "overlay" : "badge";
        await persist();
        await syncOverlay();
        status(
          config.mode === "overlay"
            ? connected
              ? "波形图模式（桌面左上角）"
              : "波形图模式：连接设备后显示悬浮窗"
            : "徽标模式（宠物旁小字）",
        );
        break;
      }
      default:
        status(`未知指令: ${cmd.action}`, "error");
    }
  } catch (err) {
    status(String(err?.message ?? err), "error");
  }
}

export async function activate(context) {
  ctx = context;

  // 恢复持久化配置（只认白名单字段）
  try {
    const saved = await ctx.storage.get("config");
    if (saved && typeof saved === "object") {
      config = {
        device: typeof saved.device === "string" ? saved.device : null,
        deviceName: typeof saved.deviceName === "string" ? saved.deviceName : null,
        mode: saved.mode === "overlay" ? "overlay" : "badge",
      };
    }
  } catch (err) {
    ctx.log("读取配置失败", err);
  }

  // 事件接线
  unsubs.push(
    ctx.bus.subscribe("ble:heart-rate", (e) => {
      ctx.bus.publish(TOPIC_BPM, { bpm: e.bpm });
    }),
  );
  unsubs.push(
    ctx.bus.subscribe("ble:device-found", (d) => {
      ctx.bus.publish(TOPIC_DEVICES, d);
    }),
  );
  unsubs.push(
    ctx.bus.subscribe("ble:disconnected", async () => {
      connected = false;
      await syncOverlay(); // 设备掉线自动关闭悬浮窗
      status("设备连接已断开", "error");
    }),
  );
  unsubs.push(ctx.bus.subscribe(TOPIC_CMD, handleCmd));

  // 恢复显示状态
  await syncOverlay();
  if (config.device) {
    // 稍等 BLE 子系统就绪后自动重连
    setTimeout(() => {
      void handleCmd({ action: "connect", deviceId: config.device, deviceName: config.deviceName });
    }, 800);
  } else {
    status("就绪，请选择蓝牙设备");
  }
}

export async function deactivate() {
  for (const off of unsubs.splice(0)) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
  try {
    await ctx?.overlay.destroy();
  } catch {
    /* 忽略 */
  }
  try {
    await ctx?.ble.stopScan();
    await ctx?.ble.disconnect();
  } catch {
    /* 忽略 */
  }
  connected = false;
  ctx = null;
}
