// Ported from goat-gauge (MIT, Copyright (c) 2026 langjinusi985360)
// https://github.com/langjinusi985360/goat-gauge — app/commandcode_api.py KNOWN_PLANS
//
// 套餐月额度是本地表，不向上游推算：未知套餐只显示剩余量。最长前缀匹配，
// 所以 individual-pro-v1 必须先于 individual-pro 命中。
export const KNOWN_PLANS = {
  "individual-go": { name: "Go", monthlyCredits: 10 },
  "individual-goat": { name: "GOAT", monthlyCredits: 70 },
  "individual-pro": { name: "Pro", monthlyCredits: 30 },
  "individual-pro-v1": { name: "Pro", monthlyCredits: 80 },
  "individual-provider": { name: "Provider", monthlyCredits: 15 },
  "individual-max": { name: "Max", monthlyCredits: 150 },
  "individual-ultra": { name: "Ultra", monthlyCredits: 300 },
  "teams-pro": { name: "Teams Pro", monthlyCredits: 40 },
};

const ORDERED = Object.entries(KNOWN_PLANS).sort(([a], [b]) => b.length - a.length);

/**
 * @param {unknown} planId
 * @returns {{name: string, monthlyCredits: number} | null}
 */
export function planInfo(planId) {
  const normalized = String(planId ?? "")
    .toLowerCase()
    .replace(/_/g, "-");
  for (const [prefix, info] of ORDERED) {
    if (normalized.startsWith(prefix)) return { ...info };
  }
  return null;
}
