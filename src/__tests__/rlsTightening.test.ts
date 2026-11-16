import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CREW_ONLY_THEIR_JOBS, jobMoneyEdits, mayChangeJob } from "../permissions";
import { actorIsMember } from "../auditText";
import { isRefusalCode } from "../data/supabaseAdapter";

// Security audit 3, the "rls tightening" rules. The
// database rules are proved in supabase/tests/database/rls_tightening.test.sql;
// these tests cover the app side and guard the migration's key lines.

const job = { crewIds: ["cal", "gus"], date: "2026-12-14" };
const other = { crewIds: ["own"], date: "2026-12-15" };
const climber = { canManage: false, canEditJobs: true, dayCrews: [] };

describe("mayChangeJob: see all jobs is for looking", () => {
  it("the office changes any job", () => {
    expect(mayChangeJob(other, "x", { canManage: true, canEditJobs: true, dayCrews: [] })).toBe(true);
  });

  it("a Climber changes a job he is on", () => {
    expect(mayChangeJob(job, "cal", climber)).toBe(true);
  });

  it("a Climber cannot change a job he is not on, even if he can see it", () => {
    expect(mayChangeJob(other, "cal", climber)).toBe(false);
  });

  it("a Climber changes a job of his day crew on that day only", () => {
    const dayCrews = [{ date: "2026-12-15", memberIds: ["cal", "own"] }];
    expect(mayChangeJob(other, "cal", { ...climber, dayCrews })).toBe(true);
    const otherDay = [{ date: "2026-12-16", memberIds: ["cal", "own"] }];
    expect(mayChangeJob(other, "cal", { ...climber, dayCrews: otherDay })).toBe(false);
  });

  it("a groundsman changes no job's fields", () => {
    expect(mayChangeJob(job, "gus", { canManage: false, canEditJobs: false, dayCrews: [] })).toBe(false);
  });

  it("the price box follows the job rule", () => {
    const edits = jobMoneyEdits({
      canEdit: false,
      canEditJobs: mayChangeJob(other, "cal", climber),
      seeMoney: false,
    });
    expect(edits.prices).toBe(false);
  });

  it("crew are told plainly", () => {
    expect(CREW_ONLY_THEIR_JOBS).toBe(
      "You can only change the jobs you are on. Ask the office to change this one.",
    );
  });
});

describe("baseline migration: the rls tightening rules", () => {
  const sql = readFileSync(
    resolve(__dirname, "../../supabase/migrations/20260101000000_baseline.sql"),
    "utf8",
  );
  const fn = (name: string) => {
    const start = sql.indexOf(`CREATE FUNCTION public.${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = sql.slice(start).search(/\$[_a-z]*\$;/);
    return sql.slice(start, start + end);
  };

  it("job_row_assigned no longer lets see all jobs change a job", () => {
    expect(fn("job_row_assigned")).not.toContain("seeAllJobs");
    expect(fn("job_row_visible")).toContain("crew_perm(p_company_id, 'seeAllJobs')");
  });

  it("a Climber cannot change the invoice link or the repeat settings", () => {
    const body = fn("limit_crew_job_edits");
    for (const col of ["invoice_id", "recurring", "recurring_until"]) {
      expect(body).toContain(`NEW.${col} IS DISTINCT FROM OLD.${col}`);
    }
    expect(body).toContain("NOT IN ('scheduled', 'in_progress', 'done')");
  });

  it("crew history entries are signed with the login's own name", () => {
    const body = fn("limit_member_audit_entries");
    expect(body).toContain("NEW.actor := public.audit_actor_name(NEW.company_id)");
    expect(body).toContain("NEW.actor_user := auth.uid()");
    expect(body).toContain("can_read_job(NEW.company_id, NEW.job_id)");
    expect(fn("audit_actor_name")).toContain("' (' || v_id || ')'");
  });

  it("a job's history needs a job the login may change, not just see", () => {
    const body = fn("limit_member_audit_entries");
    expect(body).toContain("NEW.job_id IS DISTINCT FROM NEW.entity_id");
    expect(body).toContain("public.can_change_job(NEW.company_id, NEW.job_id)");
    expect(fn("can_change_job")).toContain("job_row_assigned(j.company_id, j.crew_ids, j.date)");
  });

  it("refused history entries use the refusal code the app drops", () => {
    const body = fn("limit_member_audit_entries");
    expect(body).not.toContain("22001");
    expect(body.match(/ERRCODE = '42501'/g)?.length).toBe(5);
    expect(isRefusalCode("42501")).toBe(true);
    expect(isRefusalCode("22001")).toBe(false);
  });

  it("the struck-out old price counts as a price for a Climber", () => {
    expect(fn("limit_crew_job_edits")).toContain(
      "NEW.replaced_price IS DISTINCT FROM OLD.replaced_price",
    );
  });

  it("personal notes match on the login, never on the name alone", () => {
    const policies = sql
      .split(/\n(?=CREATE POLICY )/)
      .filter((p) => p.startsWith("CREATE POLICY") && p.includes(" ON public.private_notes "))
      .join("\n");
    expect(policies).not.toMatch(/kind = 'personal' AND author = /);
    expect(policies.match(/author_user = auth\.uid\(\)/g)?.length).toBe(5);
  });
});

describe("actorIsMember: history signed with a shared name", () => {
  const cal = { id: "c-1", name: "Cal Climb" };
  it("matches the plain card name", () => {
    expect(actorIsMember("Cal Climb", cal)).toBe(true);
  });
  it("matches the name with the card id", () => {
    expect(actorIsMember("Cal Climb (c-1)", cal)).toBe(true);
  });
  it("does not match the other person with the same name", () => {
    expect(actorIsMember("Cal Climb (c-2)", cal)).toBe(false);
  });
});

describe("job screens follow mayChangeJob", () => {
  const read = (f: string) => readFileSync(resolve(__dirname, "../components", f), "utf8");
  it("Schedule shows Apply crew only on jobs the viewer may change", () => {
    const src = read("Schedule.tsx");
    const at = src.indexOf("Apply crew:");
    expect(src.slice(at - 400, at)).toContain("mayChangeThisJob(j)");
  });
  it("the job drawer's title and Edit link follow the job rule", () => {
    const src = read("DetailDrawers.tsx");
    expect(src).toMatch(/\? mayEditTopJob\s*\? "Edit job"/);
    expect(src).toMatch(/onEdit=\{\s*mayEditTopJob/);
  });
});
