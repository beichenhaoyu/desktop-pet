// 宠物本体暴露给插件运行时的受控注册点。
// 插件经 ctx.pet.* 影响本体（插播状态、弹气泡），拿不到 canvas 与宿主 DOM。
import { PET_STATES } from "./petdex-states";
import type { ActionName } from "./sprites";

export type { ActionName };

/** 插件可用的状态名 = petdex 九状态，一个不多一个不少 */
export const PET_ACTIONS: ActionName[] = PET_STATES.map((s) => s.id);

export function isPetAction(value: unknown): value is ActionName {
  return typeof value === "string" && (PET_ACTIONS as string[]).includes(value);
}

export interface PetController {
  react(action: ActionName): void;
  say(text: string): void;
}

let controller: PetController | null = null;

export function registerPetController(next: PetController | null): void {
  controller = next;
}

export function petController(): PetController | null {
  return controller;
}
