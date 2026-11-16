import type { DataAdapter, SaveResult } from "./adapter";
import type { AppState, DraftMap, Job } from "../types";
import { defaultAutomations, seedState } from "./seed";
import { businessToday, isPastDueForOffice } from "../overdueInvoice";

const STATE_KEY = "treeapp:state:v1";
const DRAFTS_KEY = "treeapp:drafts:v1";

/**
 * Phase 1 implementation of the DataAdapter: an empty starting state
 * (see seed.ts) plus localStorage persistence. No network calls of
 * any kind.
 *
 * Phase 2 swaps this file for a Supabase/Firebase adapter that speaks
 * the same interface. Nothing else in the app needs to change.
 */
export class MockAdapter implements DataAdapter {
  private readState(): AppState | null {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as AppState;
    } catch {
      return null;
    }
  }

  private readDrafts(): DraftMap {
    try {
      const raw = localStorage.getItem(DRAFTS_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as DraftMap;
    } catch {
      return {};
    }
  }

  async loadState(): Promise<AppState | null> {
    const state = this.readState();
    if (state) return this.normalize(state);
    const seeded = seedState();
    await this.saveState(seeded);
    return seeded;
  }

  async saveState(state: AppState): Promise<SaveResult> {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      return { ok: true };
    } catch {
      // Storage full or unavailable: the in-memory state still works.
      return {
        ok: false,
        failedTable: "local storage",
        message: "Browser storage is full or unavailable.",
      };
    }
  }

  async loadDraft(key: string): Promise<unknown | undefined> {
    return this.readDrafts()[key];
  }

  async saveDraft(key: string, value: unknown): Promise<void> {
    try {
      const drafts = this.readDrafts();
      drafts[key] = value;
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Draft loss is acceptable; the saved record is unaffected.
    }
  }

  async clearDraft(key: string): Promise<void> {
    try {
      const drafts = this.readDrafts();
      delete drafts[key];
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // Ignore.
    }
  }

  async listDrafts(): Promise<DraftMap> {
    return this.readDrafts();
  }

  async reset(): Promise<AppState> {
    const seeded = seedState();
    await this.saveState(seeded);
    try {
      localStorage.removeItem(DRAFTS_KEY);
    } catch {
      // Ignore.
    }
    return seeded;
  }

  /**
   * Derived state that must stay true no matter how the data was saved:
   * an unpaid invoice 10 business days past its due date (Denver)
   * reads as overdue (overdueInvoice.ts).
   *
   * Also migrates state saved by earlier versions: jobs carry a
   * crewIds array (several people may be on one job). A save from the
   * brief round-2 single-assignee version carries a lone crewId
   * instead, which becomes a one-person crewIds array; a crewIds
   * array passes through unchanged. Collections added in round 2
   * default to empty when loading old saves.
   */
  private normalize(state: AppState): AppState {
    const denverDay = businessToday();
    return {
      ...state,
      crew: (state.crew ?? []).map((c) => ({
        ...c,
        appRole: c.appRole ?? "crew",
        email: c.email ?? "",
        messageIntro: c.messageIntro ?? "",
      })),
      customers: (state.customers ?? []).map((c) => ({
        ...c,
        mapLat: c.mapLat ?? null,
        mapLng: c.mapLng ?? null,
        boundary: c.boundary ?? null,
        type: c.type ?? "residential",
        companyName: c.companyName ?? null,
        projectName: c.projectName ?? null,
        projectNumber: c.projectNumber ?? null,
        poNumber: c.poNumber ?? null,
        contractNumber: c.contractNumber ?? null,
        jobSiteAddress: c.jobSiteAddress ?? null,
        billingTerms: c.billingTerms ?? null,
        contacts: c.contacts ?? [],
      })),
      trees: (state.trees ?? []).map((t) => ({
        ...t,
        dbhHistory: t.dbhHistory ?? [],
        conditionHistory: t.conditionHistory ?? [],
        riskRating: t.riskRating ?? "",
        riskNotes: t.riskNotes ?? "",
        nextInspectionDate: t.nextInspectionDate ?? null,
        source: t.source ?? "manual",
        siteId: t.siteId ?? null,
      })),
      equipment: state.equipment ?? [],
      maintenanceTasks: state.maintenanceTasks ?? [],
      maintenanceRecords: state.maintenanceRecords ?? [],
      equipmentNotes: state.equipmentNotes ?? [],
      closedDays: state.closedDays ?? [],
      dayCrews: state.dayCrews ?? [],
      unavailability: state.unavailability ?? [],
      locationRequests: state.locationRequests ?? [],
      crewLocations: state.crewLocations ?? [],
      bookingRequests: state.bookingRequests ?? [],
      phcPrograms: state.phcPrograms ?? [],
      phcVisits: state.phcVisits ?? [],
      chemicalRecords: state.chemicalRecords ?? [],
      jobs: (state.jobs as Array<Job & { crewId?: string | null }>).map((j) => {
        const { crewId, ...rest } = j;
        return {
          ...rest,
          crewIds: j.crewIds ?? (crewId ? [crewId] : []),
          value: (j as Job).value ?? null,
          treeIds: (j as Job).treeIds ?? [],
          equipmentIds: (j as Job).equipmentIds ?? [],
          endDate: (j as Job).endDate ?? null,
          recurring: (j as Job).recurring ?? null,
          recurringUntil: (j as Job).recurringUntil ?? null,
          materialsCost: (j as Job).materialsCost ?? null,
          otherCost: (j as Job).otherCost ?? null,
          laborRate: (j as Job).laborRate ?? null,
          lat: (j as Job).lat ?? null,
          lng: (j as Job).lng ?? null,
        };
      }),
      estimates: (state.estimates ?? []).map((e) => ({
        ...e,
        discountType: e.discountType ?? "none",
        discountValue: e.discountValue ?? 0,
        emailQueuedAt: e.emailQueuedAt ?? null,
        options: e.options ?? null,
        acceptedOptionId: e.acceptedOptionId ?? null,
        acceptedBy: e.acceptedBy ?? null,
        acceptedAt: e.acceptedAt ?? null,
      })),
      invoices: (state.invoices ?? []).map((i) => ({
        ...i,
        discountType: i.discountType ?? "none",
        discountValue: i.discountValue ?? 0,
        emailQueuedAt: i.emailQueuedAt ?? null,
        splits: i.splits ?? [],
        status:
          i.status === "unpaid" && isPastDueForOffice(i.dueDate, denverDay)
            ? ("overdue" as const)
            : i.status,
      })),
      timesheets: (state.timesheets ?? []).map((t) => ({
        ...t,
        location: t.location ?? "",
      })),
      notes: state.notes ?? [],
      threads: state.threads ?? [],
      messages: (state.messages ?? []).map((m) => ({
        ...m,
        jobId: m.jobId ?? null,
        estimateId: m.estimateId ?? null,
        fromNumber: m.fromNumber ?? null,
        threadId: m.threadId ?? null,
        queued: m.queued ?? false,
      })),
      auditLog: state.auditLog ?? [],
      automations: state.automations ?? defaultAutomations(),
      timeOff: state.timeOff ?? [],
      settings: {
        ...(state.settings ?? {}),
        autoClock: state.settings?.autoClock ?? false,
        dailyTarget: state.settings?.dailyTarget ?? 0,
        suggestDays: state.settings?.suggestDays ?? true,
        hoverRoute: state.settings?.hoverRoute ?? true,
        showDayTotals: state.settings?.showDayTotals ?? true,
        commercialTermsDays: state.settings?.commercialTermsDays ?? 30,
        residentialTermsDays: state.settings?.residentialTermsDays ?? 0,
        company: state.settings?.company ?? null,
      },
    };
  }
}

export const adapter = new MockAdapter();
