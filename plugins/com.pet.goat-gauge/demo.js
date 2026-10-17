// 演示快照：确定性种子，供设置页「演示数据」和 e2e 使用。不出网。
// five_hour 默认 63% 是 e2e 断言值；exhausted/low 用来触发告警路径。
import { buildSnapshot } from "./normalize.js";

/** @type {string[]} */
export const DEMO_SCENARIOS = ["normal", "low", "exhausted"];

/**
 * @param {number} now
 * @param {string} scenario
 * @returns {Record<string, any>}
 */
export function demoSnapshot(now = Date.now(), scenario = "normal") {
  const mode = DEMO_SCENARIOS.includes(scenario) ? scenario : "normal";
  const fiveUsed = mode === "exhausted" ? 100 : mode === "low" ? 85 : 37;
  const fiveExceeded = fiveUsed >= 100;

  return buildSnapshot({
    whoami: {
      success: true,
      org: null,
      user: {
        id: "demo-user",
        name: "演示账户",
        userName: "演示账户",
        email: "demo@example.com",
      },
    },
    creditsRoot: {
      credits: {
        monthlyCredits: 42.5,
        purchasedCredits: 5,
        freeCredits: 2,
        belowThreshold: false,
        creditThreshold: 10,
      },
      windowLimits: {
        limited: true,
        exceeded: null,
        fiveHour: {
          used: fiveUsed,
          cap: 100,
          exceeded: fiveExceeded,
          resetAt: now + 72 * 60_000,
        },
        weekly: {
          used: 41,
          cap: 100,
          exceeded: false,
          resetAt: now + 3 * 86_400_000,
        },
      },
    },
    subscriptionRoot: {
      success: true,
      data: {
        planId: "individual-goat",
        status: "active",
        currentPeriodStart: new Date(now - 12 * 86_400_000).toISOString(),
        currentPeriodEnd: new Date(now + 18 * 86_400_000).toISOString(),
        cancelAtPeriodEnd: false,
        pendingPhase: null,
      },
    },
    summaryRoot: {
      totalCount: 128,
      totalCost: 1.23,
      averageCost: 0.0096,
      successRate: 98.4,
      completedCount: 126,
      failedCount: 2,
      totalTokensIn: 120_000,
      totalTokensOut: 45_000,
      totalCredits: 12.3,
      periodBasis: "billing-period",
    },
    apiKey: "demo",
    fetchedAt: now,
  });
}
