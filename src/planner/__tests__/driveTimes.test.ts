import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPlannerInput } from "../input";
import { planDay } from "../plan";
import { loadDriveTimes } from "../driveMatrix";
import { DATE, baseState, driver, equip, job, person } from "./fixtures";

const SHOP = { lat: 39.7, lng: -105.0 };
const A = { lat: 39.8, lng: -105.0 };
const B = { lat: 39.81, lng: -105.0 };

afterEach(() => vi.unstubAllGlobals());

describe("drives chain from the most recent stop", () => {
  it("measures each later drive from the previous job, not the shop", () => {
    // Shop -> A 20 min, A -> B 5 min, shop -> B 40 min.
    const table: Record<string, number> = {
      [`${SHOP.lat}>${A.lat}`]: 20,
      [`${A.lat}>${B.lat}`]: 5,
      [`${B.lat}>${A.lat}`]: 5,
      [`${SHOP.lat}>${B.lat}`]: 40,
      [`${A.lat}>${SHOP.lat}`]: 20,
      [`${B.lat}>${SHOP.lat}`]: 40,
    };
    const state = baseState({
      crew: [driver("c", ["climbing"]), person("g", ["ground_work", "chipper"])],
      equipment: [equip("t", "Truck"), equip("ch", "Chipper")],
      jobs: [job("a", { lat: A.lat, lng: A.lng, value: 2000 }), job("b", { lat: B.lat, lng: B.lng, value: 1000 })],
    });
    const plan = planDay(
      buildPlannerInput(state, DATE, {
        mode: "replan",
        today: DATE,
        yard: SHOP,
        driveMinutes: (p, q) => table[`${p.lat}>${q.lat}`] ?? 99,
      }),
    );
    expect(plan.crews).toHaveLength(1);
    const stops = plan.crews[0].stops;
    expect(stops.map((s) => s.jobId)).toEqual(["a", "b"]);
    expect(stops[0].driveInMin).toBe(20); // from the shop
    expect(stops[1].driveInMin).toBe(5); // from job a, not 40 from the shop
  });

  it("warns when there is no shop location", () => {
    const state = baseState({
      crew: [driver("c", ["climbing"]), person("g", ["ground_work"])],
      jobs: [job("a", { lat: A.lat, lng: A.lng })],
    });
    const plan = planDay(buildPlannerInput(state, DATE, { mode: "replan", today: DATE, yard: null }));
    expect(plan.flags.some((f) => f.code === "NO_YARD")).toBe(true);
  });
});

describe("loadDriveTimes", () => {
  it("uses road times from one table request", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: "Ok", durations: [[0, 600], [660, 0]] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const t = await loadDriveTimes([SHOP, A]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(t.minutes(SHOP, A)).toBe(10);
    expect(t.minutes(A, SHOP)).toBe(11);
    expect(t.estimated).toBe(0);
  });

  it("falls back to straight-line estimates when routing is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const t = await loadDriveTimes([SHOP, B]);
    expect(t.road).toBe(0);
    expect(t.estimated).toBe(2);
    expect(t.minutes(SHOP, B)).toBeGreaterThan(0);
  });
});

describe("planning shop", () => {
  const sites = [
    { label: "Harvard", address: "1 E Harvard Ave", lat: 39.67, lng: -104.98 },
    { label: "Shop", address: "2 Main St", lat: 39.7, lng: -104.99 },
    { label: "Tejon", address: "3 Tejon St", lat: null, lng: null },
  ];
  const withSites = (yardSite?: string) =>
    baseState({
      settings: {
        ...baseState().settings,
        company: { sites } as never,
        planner: yardSite ? { yardSite } : null,
      },
    });
  it("uses the chosen shop", async () => {
    const { plannerYard } = await import("../input");
    expect(plannerYard(withSites("2 Main St"))?.label).toBe("Shop");
  });
  it("falls back to the first shop on the map", async () => {
    const { plannerYard } = await import("../input");
    expect(plannerYard(withSites())?.label).toBe("Harvard");
    expect(plannerYard(withSites("3 Tejon St"))?.label).toBe("Harvard"); // Tejon is not on the map
  });
});
