import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOKING_LIMITS,
  BOOKING_LIMIT_MESSAGES,
  clientIp,
  phoneKey,
  visitorBucket,
} from "../../supabase/functions/_shared/visitorKey.ts";
import { CREW_CANNOT_MOVE_JOB, mayMoveJobToDate } from "../permissions";

// A tiny stand-in for the Supabase client: records every call and
// answers inserts / updates / rpc pages from the test's script.
type Call = { op: string; table?: string; body?: unknown; key?: unknown };
const calls: Call[] = [];
let insertResult: (body: unknown) => { error: { code: string; message: string } | null } = () => ({ error: null });
let updateRows: (key: unknown) => unknown[] = () => [{ id: "x" }];
let rpcPages: Array<{ data: unknown[] | null; error: { code: string; message: string } | null }> = [];
let tableRows: unknown[] = [];

function fakeSupabase() {
  return {
    from(table: string) {
      return {
        insert(body: unknown) {
          calls.push({ op: "insert", table, body });
          return Promise.resolve(insertResult(body));
        },
        update(body: unknown) {
          const call: Call = { op: "update", table, body };
          calls.push(call);
          const chain = {
            eq(col: string, v: unknown) {
              if (col === "id") call.key = v;
              return chain;
            },
            select() {
              return Promise.resolve({ data: updateRows(call.key), error: null });
            },
          };
          return chain;
        },
        select() {
          calls.push({ op: "select", table });
          const chain = {
            eq: () => chain,
            order: () => chain,
            range: () => Promise.resolve({ data: tableRows, error: null }),
          };
          return chain;
        },
      };
    },
    rpc(name: string, args: unknown) {
      calls.push({ op: "rpc", table: name, body: args });
      const chain = {
        order: () => chain,
        range: () => Promise.resolve(rpcPages.shift() ?? { data: [], error: null }),
      };
      return chain;
    },
  };
}

vi.mock("../data/supabaseClient", () => ({ supabase: fakeSupabase() }));

const { fetchJobRows, insertOrUpdateRows, isMissingFunction } = await import("../data/supabaseAdapter");

beforeEach(() => {
  calls.length = 0;
  insertResult = () => ({ error: null });
  updateRows = () => [{ id: "x" }];
  rpcPages = [];
  tableRows = [];
});

describe("jobs load through app_jobs (crew never get office notes or hidden prices)", () => {
  it("reads jobs with the app_jobs function, page by page", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `j${i}` }));
    rpcPages = [{ data: page, error: null }, { data: [{ id: "last" }], error: null }];
    const rows = await fetchJobRows();
    expect(rows).toHaveLength(1001);
    expect(calls.filter((c) => c.op === "rpc").map((c) => c.table)).toEqual(["app_jobs", "app_jobs"]);
    expect(calls.some((c) => c.op === "select")).toBe(false);
  });

  it("falls back to the table on a database without app_jobs yet", async () => {
    rpcPages = [{ data: null, error: { code: "PGRST202", message: "no function" } }];
    tableRows = [{ id: "j1" }];
    expect(await fetchJobRows()).toEqual([{ id: "j1" }]);
  });

  it("any other error is a failed load, not an empty company", async () => {
    rpcPages = [{ data: null, error: { code: "42501", message: "nope" } }];
    await expect(fetchJobRows()).rejects.toThrow(/jobs read failed/);
  });

  it("knows the 'no such function' codes", () => {
    expect(isMissingFunction({ code: "PGRST202" })).toBe(true);
    expect(isMissingFunction({ code: "42883" })).toBe(true);
    expect(isMissingFunction({ code: "42501" })).toBe(false);
  });
});

describe("saving jobs without an upsert", () => {
  it("new jobs are one plain insert", async () => {
    await insertOrUpdateRows("jobs", [{ id: "a" }, { id: "b" }], "id");
    expect(calls).toEqual([{ op: "insert", table: "jobs", body: [{ id: "a" }, { id: "b" }] }]);
  });

  it("a job that already exists is updated instead (same result as an upsert)", async () => {
    insertResult = (body) =>
      Array.isArray(body) || (body as { id: string }).id === "old"
        ? { error: { code: "23505", message: "duplicate" } }
        : { error: null };
    await insertOrUpdateRows("jobs", [{ id: "new", title: "N" }, { id: "old", title: "O" }], "id");
    const updates = calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].key).toBe("old");
    expect(updates[0].body).toEqual({ title: "O" });
  });

  it("an update the database lets through to no row counts as refused", async () => {
    insertResult = () => ({ error: { code: "23505", message: "duplicate" } });
    updateRows = () => [];
    await expect(insertOrUpdateRows("jobs", [{ id: "old" }], "id")).rejects.toMatchObject({ code: "42501" });
  });

  it("a refused insert is passed on as refused", async () => {
    insertResult = () => ({ error: { code: "42501", message: "row-level security" } });
    await expect(insertOrUpdateRows("jobs", [{ id: "x" }], "id")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("crew cannot move a job to another day", () => {
  it("crew may change the time on the same day only", () => {
    expect(mayMoveJobToDate("crew", "2026-12-14", "2026-12-14")).toBe(true);
    expect(mayMoveJobToDate("crew", "2026-12-14", "2026-12-15")).toBe(false);
  });
  it("the office, managers and owners may move any job", () => {
    for (const role of ["office", "manager", "owner"] as const) {
      expect(mayMoveJobToDate(role, "2026-12-14", "2026-12-20")).toBe(true);
    }
  });
  it("tells crew in plain words", () => {
    expect(CREW_CANNOT_MOVE_JOB).toMatch(/Only the office/);
  });
});

describe("booking page: who is asking", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

  it("trusts Cloudflare's address over anything the visitor sends", () => {
    expect(clientIp(h({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "1.2.3.4" }))).toBe("198.51.100.2");
    expect(clientIp(h({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientIp(h({}))).toBe("");
  });

  it("one IPv6 home network counts as one visitor", () => {
    const a = visitorBucket("2001:db8:85a3:12:1111:2222:3333:4444");
    const b = visitorBucket("2001:0db8:85a3:0012:aaaa::1");
    expect(a).toBe("2001:db8:85a3:12::/64");
    expect(b).toBe(a);
    expect(visitorBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(visitorBucket("[2001:db8:1:2::5]")).toBe("2001:db8:1:2::/64");
  });

  it("IPv4 stays as it is", () => {
    expect(visitorBucket("203.0.113.9")).toBe("203.0.113.9");
    expect(visitorBucket("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(visitorBucket("")).toBe("unknown");
  });

  it("phone numbers match however they are typed", () => {
    expect(phoneKey("+1 (555) 555-0101")).toBe("5555550101");
    expect(phoneKey("555.555.0101")).toBe("5555550101");
    expect(phoneKey("12")).toBe("");
  });

  it("has a plain message for every refusal and sensible caps", () => {
    for (const k of ["visitor", "daily", "backlog"]) expect(BOOKING_LIMIT_MESSAGES[k]).toMatch(/call us/);
    expect(BOOKING_LIMITS.perDay).toBeGreaterThan(BOOKING_LIMITS.perVisitorPerHour);
    expect(BOOKING_LIMITS.maxPending).toBeGreaterThan(BOOKING_LIMITS.perDay);
  });
});
