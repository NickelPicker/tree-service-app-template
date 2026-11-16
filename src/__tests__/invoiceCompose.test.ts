import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BLANK_DRAFT,
  composeStorageKey,
  discardCompose,
  draftHasContent,
  draftInvoice,
  finishCompose,
  getComposeState,
  minimizeCompose,
  openCompose,
  restoreCompose,
  setComposeOwner,
  setComposeStorage,
  toggleExpandCompose,
  updateComposeDraft,
} from "../invoiceCompose";
import { clearLocalCompanyData } from "../data/localData";

class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  setComposeStorage(store);
  setComposeOwner(null);
  setComposeOwner("user-a");
});
afterEach(() => {
  discardCompose();
  setComposeOwner(null);
  setComposeStorage(null);
});

describe("New invoice pop-up store", () => {
  it("opens a blank draft", () => {
    expect(getComposeState().open).toBe(false);
    openCompose();
    const s = getComposeState();
    expect(s.open).toBe(true);
    expect(s.minimized).toBe(false);
    expect(s.draft).toEqual(BLANK_DRAFT);
  });

  it("minimizes and restores without losing the draft", () => {
    openCompose();
    updateComposeDraft({ desc: "Crown clean", amount: 450 });
    minimizeCompose();
    expect(getComposeState().minimized).toBe(true);
    expect(getComposeState().open).toBe(true);
    restoreCompose();
    expect(getComposeState().minimized).toBe(false);
    expect(getComposeState().draft.desc).toBe("Crown clean");
  });

  it("+ New invoice again restores the existing draft instead of wiping it", () => {
    openCompose();
    updateComposeDraft({ custId: "c1", desc: "Stump grind" });
    minimizeCompose();
    const before = getComposeState().focusRequest;
    openCompose();
    const s = getComposeState();
    expect(s.minimized).toBe(false);
    expect(s.draft.custId).toBe("c1");
    expect(s.draft.desc).toBe("Stump grind");
    expect(s.focusRequest).toBeGreaterThan(before);
  });

  it("expand toggles and un-minimizes", () => {
    openCompose();
    minimizeCompose();
    toggleExpandCompose();
    expect(getComposeState().expanded).toBe(true);
    expect(getComposeState().minimized).toBe(false);
  });

  it("keeps the draft per person across a reload", () => {
    openCompose();
    updateComposeDraft({ desc: "Removal", amount: 1200, due: "2026-12-01", dueTouched: true });
    minimizeCompose();
    expect(store.getItem(composeStorageKey("user-a"))).not.toBeNull();

    // A reload: memory empty, same person signs back in.
    setComposeOwner(null);
    expect(getComposeState().open).toBe(false);
    setComposeOwner("user-a");
    const s = getComposeState();
    expect(s.open).toBe(true);
    expect(s.minimized).toBe(true);
    expect(s.draft).toMatchObject({ desc: "Removal", amount: 1200, due: "2026-12-01", dueTouched: true });

    // Someone else on the same browser does not see it.
    setComposeOwner("user-b");
    expect(getComposeState().open).toBe(false);
  });

  it("keeps nothing for a signed-out viewer", () => {
    setComposeOwner(null);
    openCompose();
    updateComposeDraft({ desc: "Secret" });
    expect(store.length).toBe(0);
  });

  it("clears the draft after a successful save", () => {
    openCompose();
    updateComposeDraft({ custId: "c1", desc: "Pruning" });
    finishCompose();
    expect(getComposeState().open).toBe(false);
    expect(getComposeState().draft).toEqual(BLANK_DRAFT);
    expect(store.getItem(composeStorageKey("user-a"))).toBeNull();
    openCompose();
    expect(getComposeState().draft).toEqual(BLANK_DRAFT);
  });

  it("discard closes and clears the kept copy", () => {
    openCompose();
    updateComposeDraft({ desc: "Cabling" });
    expect(draftHasContent(getComposeState().draft)).toBe(true);
    discardCompose();
    expect(getComposeState().open).toBe(false);
    expect(store.getItem(composeStorageKey("user-a"))).toBeNull();
  });

  it("an empty draft has nothing to lose; a picked due date alone does", () => {
    expect(draftHasContent(BLANK_DRAFT)).toBe(false);
    expect(draftHasContent({ ...BLANK_DRAFT, due: "2026-12-01" })).toBe(false);
    expect(draftHasContent({ ...BLANK_DRAFT, due: "2026-12-01", dueTouched: true })).toBe(true);
  });

  it("ignores a broken stored copy", () => {
    setComposeOwner(null);
    store.setItem(composeStorageKey("user-c"), "{not json");
    setComposeOwner("user-c");
    expect(getComposeState().open).toBe(false);
  });

  it("survives storage that throws", () => {
    setComposeOwner(null);
    const broken = new MemoryStorage();
    broken.setItem = () => {
      throw new Error("quota");
    };
    broken.getItem = () => {
      throw new Error("blocked");
    };
    setComposeStorage(broken);
    setComposeOwner("user-d");
    openCompose();
    updateComposeDraft({ desc: "Still here" });
    expect(getComposeState().draft.desc).toBe("Still here");
  });

  it("the sign-out wipe removes the kept draft", async () => {
    openCompose();
    updateComposeDraft({ desc: "Lot clearing" });
    const g = globalThis as { localStorage?: Storage };
    const had = g.localStorage;
    g.localStorage = store;
    try {
      store.setItem("nav-order-x", "[]");
      await clearLocalCompanyData();
      expect(store.getItem(composeStorageKey("user-a"))).toBeNull();
      expect(store.getItem("nav-order-x")).toBe("[]");
    } finally {
      g.localStorage = had;
    }
  });
});

describe("Preview email follows the draft as it is now", () => {
  const opts = { id: "preview", lineId: "l", number: "1001", today: "2026-11-16", defaultDue: "2026-11-16" };
  it("an edit after Preview shows the new amount and words", () => {
    const draft = { custId: "c1", desc: "Prune oak", amount: 400, due: "" };
    expect(draftInvoice(draft, opts)?.lines[0]).toMatchObject({ description: "Prune oak", unitPrice: 400 });
    const edited = { ...draft, desc: "Prune two oaks", amount: 650 };
    expect(draftInvoice(edited, opts)?.lines[0]).toMatchObject({ description: "Prune two oaks", unitPrice: 650 });
  });
  it("needs a customer and a description; uses the typed due date or the default", () => {
    expect(draftInvoice({ custId: "", desc: "x", amount: 1, due: "" }, opts)).toBeNull();
    expect(draftInvoice({ custId: "c1", desc: "  ", amount: 1, due: "" }, opts)).toBeNull();
    expect(draftInvoice({ custId: "c1", desc: "x", amount: 1, due: "2026-12-01" }, opts)?.dueDate).toBe("2026-12-01");
    expect(draftInvoice({ custId: "c1", desc: "x", amount: 1, due: "" }, opts)?.dueDate).toBe("2026-11-16");
  });
});
