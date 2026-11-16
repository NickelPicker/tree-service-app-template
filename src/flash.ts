import { useSyncExternalStore } from "react";

/**
 * One short confirmation line at the bottom of the screen ("Sent to
 * carl@example.com — now under Sent"), with optional buttons such as
 * "Open job · Plan that day". It stays until closed or replaced, so a
 * form can close and the person still sees what happened.
 */
export interface FlashAction {
  label: string;
  run: () => void;
}
export interface Flash {
  id: number;
  text: string;
  tone: "ok" | "warn";
  actions: FlashAction[];
}

let current: Flash | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function showFlash(
  text: string,
  opts: { tone?: "ok" | "warn"; actions?: FlashAction[] } = {},
): void {
  current = { id: nextId++, text, tone: opts.tone ?? "ok", actions: opts.actions ?? [] };
  emit();
}

export function clearFlash(): void {
  current = null;
  emit();
}

export function getFlash(): Flash | null {
  return current;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useFlash(): Flash | null {
  return useSyncExternalStore(subscribe, getFlash, getFlash);
}
