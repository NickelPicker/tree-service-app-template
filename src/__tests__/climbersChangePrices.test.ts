import { describe, expect, it } from "vitest";
import { jobMoneyEdits } from "../permissions";

// Owner decision ("climbers can change prices"), migration
// the "climbers change prices" rules: a crew Climber changes a job's prices without "see
// money"; its costs only with "see money". Since the "climber price change notes" rules only
// with a reason, through the price box (withReason).
describe("jobMoneyEdits", () => {
  it("a Climber without see money changes prices but not costs", () => {
    expect(jobMoneyEdits({ canEdit: false, canEditJobs: true, seeMoney: false })).toEqual({
      prices: true,
      costs: false,
      withReason: true,
    });
  });

  it("a Climber with see money changes prices and costs", () => {
    expect(jobMoneyEdits({ canEdit: false, canEditJobs: true, seeMoney: true })).toEqual({
      prices: true,
      costs: true,
      withReason: true,
    });
  });

  it("a Groundsman changes neither, with or without see money", () => {
    for (const seeMoney of [false, true]) {
      expect(jobMoneyEdits({ canEdit: false, canEditJobs: false, seeMoney })).toEqual({
        prices: false,
        costs: false,
        withReason: false,
      });
    }
  });

  it("the office, managers and owners change both, no reason asked", () => {
    expect(jobMoneyEdits({ canEdit: true, canEditJobs: true, seeMoney: true })).toEqual({
      prices: true,
      costs: true,
      withReason: false,
    });
  });
});
