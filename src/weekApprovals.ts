import { supabaseConfig } from "./config";
import { supabase } from "./data/supabaseClient";

/**
 * "Approve week" on Timesheets (owners and managers). Live: one row in
 * timesheet_week_approvals per week (the database fills in who and
 * when, and only owners/managers can read or change it). Demo mode
 * (no Supabase project): kept in this browser only.
 */
export interface WeekApproval {
  weekStart: string;
  approvedBy: string;
  approvedAt: string;
  totalHours: number;
}

const LOCAL_KEY = "treeapp:week-approvals";

function readLocal(): Record<string, WeekApproval> {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as Record<string, WeekApproval>) : {};
  } catch {
    return {};
  }
}
function writeLocal(v: Record<string, WeekApproval>) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
  } catch {
    /* private window: nothing to keep */
  }
}

export async function loadWeekApproval(weekStart: string): Promise<WeekApproval | null> {
  if (!supabase) return readLocal()[weekStart] ?? null;
  const { data, error } = await supabase
    .from("timesheet_week_approvals")
    .select("week_start,approved_by,approved_at,total_hours")
    .eq("company_id", supabaseConfig.companyId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (error || !data) return null;
  return approvalFromRow(data);
}

/**
 * Every approval of a week that starts before `beforeMonday` (and, when
 * given, on or after `fromMonday`), by Monday. The Dashboard To-do asks
 * for the previous 2 weeks only. Null when it could not be loaded.
 */
export async function loadWeekApprovalsBefore(
  beforeMonday: string,
  fromMonday?: string,
): Promise<Record<string, WeekApproval> | null> {
  if (!supabase) {
    const all = readLocal();
    return Object.fromEntries(
      Object.entries(all).filter(([k]) => k < beforeMonday && (!fromMonday || k >= fromMonday)),
    );
  }
  let q = supabase
    .from("timesheet_week_approvals")
    .select("week_start,approved_by,approved_at,total_hours")
    .eq("company_id", supabaseConfig.companyId)
    .lt("week_start", beforeMonday);
  if (fromMonday) q = q.gte("week_start", fromMonday);
  const { data, error } = await q;
  if (error || !data) return null;
  const out: Record<string, WeekApproval> = {};
  for (const row of data as Record<string, unknown>[]) {
    const a = approvalFromRow(row);
    out[a.weekStart] = a;
  }
  return out;
}

function approvalFromRow(data: Record<string, unknown>): WeekApproval {
  return {
    weekStart: String(data.week_start),
    approvedBy: String(data.approved_by ?? ""),
    approvedAt: String(data.approved_at ?? ""),
    totalHours: Number(data.total_hours ?? 0),
  };
}

/** Approve the week. Returns the saved approval, or an error line. */
export async function approveWeek(
  weekStart: string,
  totalHours: number,
  approverName: string,
): Promise<{ ok: true; approval: WeekApproval } | { ok: false; message: string }> {
  const hours = Math.round(totalHours * 100) / 100;
  if (!supabase) {
    const approval: WeekApproval = {
      weekStart,
      approvedBy: approverName,
      approvedAt: new Date().toISOString(),
      totalHours: hours,
    };
    writeLocal({ ...readLocal(), [weekStart]: approval });
    return { ok: true, approval };
  }
  // One server call replaces any old approval in a single transaction
  // (the "office fixes" rules): either the new one is saved or the old
  // one stays.
  const { data, error } = await supabase.rpc("approve_timesheet_week", {
    p_company: supabaseConfig.companyId,
    p_week: weekStart,
    p_hours: hours,
  });
  if (error) {
    return {
      ok: false,
      message:
        error.code === "42501"
          ? "Only an owner or manager can approve a week."
          : "Could not save the approval. Check your connection and try again.",
    };
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const saved = row ? approvalFromRow(row) : await loadWeekApproval(weekStart);
  return saved
    ? { ok: true, approval: saved }
    : { ok: false, message: "Could not save the approval. Try again." };
}

export async function undoWeekApproval(weekStart: string): Promise<boolean> {
  if (!supabase) {
    const all = readLocal();
    delete all[weekStart];
    writeLocal(all);
    return true;
  }
  const { error } = await supabase
    .from("timesheet_week_approvals")
    .delete()
    .eq("company_id", supabaseConfig.companyId)
    .eq("week_start", weekStart);
  return !error;
}
