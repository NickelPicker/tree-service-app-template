/**
 * Equipment "Problem" reports: the rules behind the button, no React
 * here so they are unit tested on their own (migration
 * the "equipment problems" rules enforces the same limits).
 */
import type { EquipmentProblem, EquipmentProblemStatus } from "./types";

/** Longest report text (the database checks the same). */
export const PROBLEM_NOTE_MAX = 1000;
/** Largest stored photo: 2 MB (equipment_problem_photos.size_bytes). */
export const PROBLEM_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
/** Photos are redrawn so their longest side is at most this many pixels. */
export const PROBLEM_PHOTO_MAX_SIDE = 1600;

/** Why this text cannot be sent, or null when it can. */
export function problemNoteProblem(note: string): string | null {
  const t = note.trim();
  if (t.length === 0) return "Say what is wrong (a few words is fine).";
  if (t.length > PROBLEM_NOTE_MAX) return `Keep it under ${PROBLEM_NOTE_MAX} characters.`;
  return null;
}

/** Still needs the office: open, or in the shop. */
export function isUnresolved(p: Pick<EquipmentProblem, "status">): boolean {
  return p.status === "open" || p.status === "in_shop";
}

/** Reports nobody in the office has dealt with yet, oldest first. */
export function openProblems(list: EquipmentProblem[] | undefined): EquipmentProblem[] {
  return (list ?? [])
    .filter((p) => p.status === "open")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Open or in-the-shop reports on one machine, newest first. */
export function unresolvedFor(list: EquipmentProblem[] | undefined, equipmentId: string): EquipmentProblem[] {
  return (list ?? [])
    .filter((p) => p.equipmentId === equipmentId && isUnresolved(p))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Fixed reports on one machine, newest first (at most `limit`). */
export function recentlyFixedFor(
  list: EquipmentProblem[] | undefined,
  equipmentId: string,
  limit = 3,
): EquipmentProblem[] {
  return (list ?? [])
    .filter((p) => p.equipmentId === equipmentId && p.status === "fixed")
    .sort((a, b) => (b.statusAt ?? "").localeCompare(a.statusAt ?? ""))
    .slice(0, limit);
}

/** The reports one person made (crew see only theirs anyway), newest first. */
export function myProblems(
  list: EquipmentProblem[] | undefined,
  crewId: string,
  limit = 5,
): EquipmentProblem[] {
  return (list ?? [])
    .filter((p) => p.reportedBy === crewId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function problemStatusLabel(s: EquipmentProblemStatus): string {
  return s === "open" ? "Open" : s === "in_shop" ? "In the shop" : "Fixed";
}

/** Status after an office action (what the database sets too). */
export function statusAfter(action: "fixed" | "shop"): EquipmentProblemStatus {
  return action === "fixed" ? "fixed" : "in_shop";
}
