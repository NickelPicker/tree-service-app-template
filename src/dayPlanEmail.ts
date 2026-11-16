/**
 * Email everyone their day: after "Save day" the plan board calls
 * emailDayPlan(date) and the send-day-plan edge function sends each
 * crew member on a job that day one email (their stops, times,
 * directions, who else is there, what they drive, team notes).
 *
 * The function runs as the logged-in user (their session token), so
 * row-level security applies; only office staff can send. It returns
 * counts only. In demo mode (no Supabase project) nothing is sent.
 */
import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";
import { dayPlanRecipientCount } from "../supabase/functions/send-day-plan/compose.ts";
import type { CrewMember, Job, PlannerSettings } from "./types";

export interface DayPlanEmailResult {
  sent: number;
  skipped: number;
  /** Already had exactly this plan by email, so not emailed again. */
  unchanged?: number;
  /** Held back by email test mode (not sent, no try used). */
  blocked?: number;
  /** Gmail refused it, or this exact email already failed 3 times. */
  failed?: number;
  /** "demo" | "gmail-not-set-up" | "needs-confirm" | "error", when nothing could be sent. */
  reason?: string;
}

/**
 * How many crew members Save day would email for `date` (people on that
 * day's unfinished jobs, active, with a usable email): the same count
 * the send-day-plan function uses. `jobs` should already hold the
 * board's changes (applyPatches) so it is known BEFORE saving.
 */
export function dayPlanEmailCount(date: string, jobs: Job[], crew: CrewMember[]): number {
  return dayPlanRecipientCount(
    date,
    jobs.map((j) => ({
      id: j.id,
      title: j.title,
      date: j.date,
      end_date: j.endDate,
      start_time: j.startTime,
      customer_id: j.customerId,
      crew_ids: j.crewIds,
      status: j.status,
    })),
    crew
      .filter((c) => (c.status ?? "active") === "active")
      .map((c) => ({ id: c.id, name: c.name, email: c.email })),
  );
}

/** The owner's setting; missing = off (nothing is sent until the owner turns it on). */
export function emailCrewOnSave(planner: PlannerSettings | null | undefined): boolean {
  return planner?.emailCrewOnSave === true;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Plain-English line for a toast, e.g. "Emailed 4 people their day". */
export function dayPlanEmailMessage(r: DayPlanEmailResult): string {
  if (r.reason === "demo") return "Demo mode: no emails sent";
  if (r.reason === "gmail-not-set-up") return "Crew emails are not set up yet (Gmail app password missing)";
  if (r.reason === "error") return "Could not email the crew their day";
  if (r.reason === "too-many") return "Day saved. No emails sent: that's a lot of day-plan emails this hour. Try again later";
  if (r.reason === "daily-limit") return "Day saved. No emails sent: today's email limit is reached";
  if (r.reason === "needs-confirm")
    return "Day saved. No emails sent: more people would get one than you confirmed. Press Save day again to confirm the new number";
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
  const unchanged = r.unchanged ?? 0;
  const blocked = r.blocked ?? 0;
  const failed = r.failed ?? 0;
  const base =
    r.sent > 0
      ? `Emailed ${people(r.sent)} their day`
      : unchanged + blocked + failed > 0
        ? "No new emails"
        : "No one to email";
  const notes: string[] = [];
  if (unchanged > 0) notes.push(`${people(unchanged)} already had this plan`);
  if (blocked > 0) notes.push(`${people(blocked)} held back by test mode`);
  if (failed > 0) notes.push(`${people(failed)} could not be emailed`);
  if (r.skipped > 0) notes.push(`${people(r.skipped)} skipped: no email saved`);
  return notes.length ? `${base} (${notes.join("; ")})` : base;
}

/** Turn the function's reply into counts, ignoring anything unexpected. */
export function parseDayPlanReply(data: unknown): DayPlanEmailResult {
  if (!data || typeof data !== "object") return { sent: 0, skipped: 0, reason: "error" };
  const d = data as Record<string, unknown>;
  const result: DayPlanEmailResult = { sent: count(d.sent), skipped: count(d.skipped) };
  if (typeof d.reason === "string" && d.reason) result.reason = d.reason;
  if (count(d.unchanged) > 0) result.unchanged = count(d.unchanged);
  if (count(d.blocked) > 0) result.blocked = count(d.blocked);
  if (count(d.failed) > 0) result.failed = count(d.failed);
  return result;
}

/** Ask the server to email each crew member on a job that day their plan. */
/**
 * `confirmed`: how many emails the person confirmed (the double confirm
 * for more than 3). The function sends nothing when more than 3 would go
 * and more than `confirmed`.
 */
export async function emailDayPlan(date: string, confirmed = 0): Promise<DayPlanEmailResult> {
  if (!supabase) return { sent: 0, skipped: 0, reason: "demo" };
  try {
    const { data, error } = await supabase.functions.invoke("send-day-plan", {
      body: { date, companyId: supabaseConfig.companyId, confirmed },
    });
    if (error) return { sent: 0, skipped: 0, reason: "error" };
    return parseDayPlanReply(data);
  } catch {
    return { sent: 0, skipped: 0, reason: "error" };
  }
}
