import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake Supabase client: records every call; the RPC answers as set.
const calls: string[] = [];
let rpcAnswer: { data: unknown; error: { code: string } | null } = { data: null, error: null };
vi.mock("../data/supabaseClient", () => {
  const table = () => {
    const q = {
      delete: () => (calls.push("delete"), q),
      insert: () => (calls.push("insert"), Promise.resolve({ error: null })),
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    };
    return q;
  };
  return {
    supabase: {
      from: table,
      rpc: (fn: string, args: Record<string, unknown>) => {
        calls.push(`rpc:${fn}:${String(args.p_week)}:${String(args.p_hours)}`);
        return Promise.resolve(rpcAnswer);
      },
    },
  };
});

const { approveWeek } = await import("../weekApprovals");

describe("Approve week replaces an approval in one server call", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("never deletes from the browser; one RPC does it all", async () => {
    rpcAnswer = {
      data: { week_start: "2026-11-09", approved_by: "Bo Boss", approved_at: "2026-11-16T10:00:00Z", total_hours: 40.5 },
      error: null,
    };
    const r = await approveWeek("2026-11-09", 40.499, "Bo");
    expect(calls).toEqual(["rpc:approve_timesheet_week:2026-11-09:40.5"]);
    expect(r).toEqual({
      ok: true,
      approval: { weekStart: "2026-11-09", approvedBy: "Bo Boss", approvedAt: "2026-11-16T10:00:00Z", totalHours: 40.5 },
    });
  });

  it("a failure says so and touches nothing else (the old approval stays)", async () => {
    rpcAnswer = { data: null, error: { code: "08006" } };
    const r = await approveWeek("2026-11-09", 41, "Bo");
    expect(r.ok).toBe(false);
    expect(calls).toEqual(["rpc:approve_timesheet_week:2026-11-09:41"]);
    rpcAnswer = { data: null, error: { code: "42501" } };
    expect(await approveWeek("2026-11-09", 41, "Bo")).toEqual({
      ok: false,
      message: "Only an owner or manager can approve a week.",
    });
  });
});
