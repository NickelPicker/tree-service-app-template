import { describe, expect, it } from "vitest";
import { autoFill, hoursFor, simulate, type MeetInput } from "../meetup";

const people = (n: number, drivers = n) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, legalDriver: i < drivers, skills: ["ground_work"] }));
const base = (over: Partial<MeetInput>): MeetInput => ({
  jobs: [],
  people: people(5),
  drive: [
    [0, 20, 25],
    [20, 0, 15],
    [25, 15, 0],
  ],
  dayStartMin: 7 * 60,
  dayEndMin: 17 * 60,
  dollarsPerHour: 400,
  fullSpeedCrew: 3,
  minTeam: 2,
  ...over,
});
const job = (id: string, work: number, node: number) => ({ id, title: id, work, node, fixedStartMin: null, climbers: 0, skills: [] });

describe("$400 an hour rule", () => {
  it("$400 = 1 hour and $800 = 2 hours for up to 3 people; more people go faster", () => {
    const i = base({});
    expect(hoursFor(i, 400, 3)).toBe(1);
    expect(hoursFor(i, 800, 2)).toBe(2);
    expect(hoursFor(i, 800, 3)).toBe(2);
    expect(hoursFor(i, 800, 6)).toBe(1);
  });
  it("a simulated $800 job with 3 people takes 2 hours on site", () => {
    const i = base({ jobs: [job("a", 800, 1)], people: people(3) });
    const s = simulate(i, { p0: ["a"], p1: ["a"], p2: ["a"] });
    expect(s.jobs.a.startMin).toBe(7 * 60 + 20);
    expect(s.jobs.a.endMin).toBe(7 * 60 + 20 + 120);
  });
});

describe("auto-fill: split up, then meet at the big job", () => {
  it("$400 job + $6,500 job, 5 people: 2 knock out the small job, 3 start the big one, the 2 join after", () => {
    const i = base({ jobs: [job("small", 400, 1), job("big", 6500, 2)] });
    const a = autoFill(i)!;
    const small = a.teams.find((t) => t.jobId === "small");
    const big = a.teams.find((t) => t.jobId === "big");
    expect(small?.people.length).toBe(2);
    expect(big?.people.length).toBe(3);
    for (const id of small!.people) expect(a.routes[id]).toEqual(["small", "big"]);
    for (const id of big!.people) expect(a.routes[id]).toEqual(["big"]);
    // The small team arrives at the big job after finishing (1 h) and driving 15 min.
    const arrive = a.sim.jobs.big.arrivals[small!.people[0]];
    expect(arrive).toBe(a.sim.jobs.small.endMin! + 15);
    expect(a.sim.unfinished).toEqual([]);
  });
  it("everyone available goes to a job site", () => {
    const i = base({ jobs: [job("small", 400, 1), job("big", 6500, 2)], people: people(8) });
    const a = autoFill(i)!;
    for (const p of i.people) expect(a.routes[p.id]?.length ?? 0).toBeGreaterThan(0);
  });
  it("one job: everyone goes there", () => {
    const i = base({ jobs: [job("big", 2000, 1)], people: people(4) });
    const a = autoFill(i)!;
    expect(a.teams).toEqual([{ jobId: "big", people: ["p0", "p1", "p2", "p3"] }]);
  });
  it("a team never leaves without a driver when it can be avoided", () => {
    const i = base({ jobs: [job("small", 400, 1), job("big", 6500, 2)], people: people(5, 1) });
    const a = autoFill(i)!;
    expect(a.teams.length).toBe(1);
  });
  it("needs a climber: the small team gets one", () => {
    const ps = people(5);
    ps[4].skills = ["climbing"];
    ps[3].skills = ["climbing"];
    const i = base({ jobs: [{ ...job("small", 400, 1), climbers: 1 }, { ...job("big", 6500, 2), climbers: 1 }], people: ps });
    const a = autoFill(i)!;
    expect(a.score[0]).toBe(0);
    const small = a.teams.find((t) => t.jobId === "small")!;
    expect(small.people.some((id) => id === "p3" || id === "p4")).toBe(true);
  });
  it("when the main crew finishes first, they go help the other job", () => {
    const i = base({ jobs: [job("a", 1200, 1), job("b", 1200, 2)], people: people(4) });
    const a = autoFill(i)!;
    expect(a.sim.unfinished).toEqual([]);
    expect(Object.keys(a.routes).length).toBe(4);
  });
});

describe("review fixes", () => {
  const flat = (n: number, m = 20) => Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => (a === b ? 0 : m)));
  it("a big job promised for 1 PM: work the other big job first instead of waiting", () => {
    const i = base({
      jobs: [{ ...job("A", 4000, 1), fixedStartMin: 13 * 60 }, job("B", 3600, 2)],
      drive: flat(3),
    });
    const a = autoFill(i)!;
    expect(a.sim.jobs.A.startMin).toBeGreaterThanOrEqual(13 * 60);
    // All 5 on B, then A from 1 PM: done about 7:04 PM (1144). Waiting at A first ends ~8:28 PM.
    expect(a.sim.finishMin).toBeLessThanOrEqual(1150);
  });
  it("nobody is sent to a job that will be done before they get there", () => {
    const i = base({
      jobs: [job("A", 400, 1), job("B", 2400, 2)],
      drive: [
        [0, 5, 5],
        [5, 0, 90],
        [90, 90, 0].map((x, k) => (k === 2 ? 0 : x)),
      ],
      people: people(5),
    });
    const a = autoFill(i)!;
    for (const [pid, r] of Object.entries(a.routes)) {
      for (const jid of r) expect(a.sim.jobs[jid].arrivals[pid]).toBeDefined();
    }
  });
});

describe("nobody alone on a job", () => {
  it("every job anyone works on gets at least the smallest team (2)", () => {
    const n = 4;
    const drive = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => (a === b ? 0 : 15)));
    const i = base({ jobs: [job("A", 400, 1), job("B", 6500, 2), job("C", 600, 3)], drive, people: people(5) });
    const a = autoFill(i)!;
    for (const j of ["A", "B", "C"]) expect(Object.keys(a.sim.jobs[j].arrivals).length).toBeGreaterThanOrEqual(2);
  });
});
