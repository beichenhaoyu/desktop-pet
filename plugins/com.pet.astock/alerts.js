// 提醒链：判定（rules.js）之后的所有触发动作 —— 系统通知、宠物反应、最近提醒列表。

import { TOPIC_ALERT } from "./topics.js";
import { config, ctx } from "./main.js";

/** 界面上保留的最近提醒条数 */
const RECENT_ALERTS = 8;
export let recent = []; // 最近提醒，给界面显示

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 宠物反应：涨=开心，跌=沮丧，到价=提醒你看一眼 */
async function reactTo(hit) {
  if (!config.petOn) return;
  try {
    if (hit.kind === "limitUp") {
      await ctx.pet.react("jumping");
      await ctx.pet.say(hit.message);
    } else if (hit.kind === "limitDown") {
      await ctx.pet.react("failed");
      await ctx.pet.say(hit.message);
    } else {
      await ctx.pet.react("waiting");
      await ctx.pet.say(hit.message);
    }
  } catch (err) {
    ctx?.log?.("宠物反应失败", err); // 已停用或本体没就绪，不影响提醒本身
  }
}

export async function fireAlerts(hits) {
  for (const hit of hits) {
    // 三条都得成功才算「今天提醒过了」：中途抛错就继续下一条，
    // 别让一次通知失败把整轮提醒打断，也别把没提醒的记成已提醒
    try {
      if (config.alertsOn) {
        await ctx.notify.show(hit.level === "down" ? "盯盘：下跌提醒" : "盯盘：上涨提醒", hit.message);
      }
      await reactTo(hit);
    } catch (err) {
      ctx?.log?.("提醒失败", err);
      continue;
    }
    recent = [{ ...hit, today: today() }, ...recent].slice(0, RECENT_ALERTS);
    ctx?.bus.publish(TOPIC_ALERT, hit);
  }
}
