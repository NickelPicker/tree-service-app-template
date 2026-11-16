import type { AuditEntry } from "./types";
import { uid } from "./utils";

/**
 * Central audit logging. EVERY mutation in the app builds its audit
 * records through the helpers here — never by hand-appending to the log
 * — so every change, down to a quantity edited from 1 to 2, is recorded
 * with timestamp, acting user, entity, field, old value, and new value.
 *
 * Values are stored as plain strings so the log reads the same way
 * regardless of field type. A field whose value did not change produces
 * no record.
 */

export interface AuditContext {
  actor: string;
  entity: string;
  entityId: string;
  entityLabel: string;
  customerId: string | null;
  /** Owning job, when this record touches a job (see types.AuditEntry). */
  jobId?: string | null;
}

function entry(
  ctx: AuditContext,
  field: string,
  oldValue: string,
  newValue: string,
): AuditEntry {
  return {
    id: uid(),
    timestamp: new Date().toISOString(),
    actor: ctx.actor,
    entity: ctx.entity,
    entityId: ctx.entityId,
    entityLabel: ctx.entityLabel,
    field,
    oldValue,
    newValue,
    customerId: ctx.customerId,
    jobId: ctx.jobId ?? null,
  };
}

/** One "(created)" record for a brand-new entity. */
export function createdEntry(ctx: AuditContext): AuditEntry {
  return entry(ctx, "(created)", "", ctx.entityLabel);
}

/** One "(deleted)" record for a removed entity. */
export function deletedEntry(ctx: AuditContext): AuditEntry {
  return entry(ctx, "(deleted)", ctx.entityLabel, "");
}

/** Format a raw value for the log: blanks read as "(blank)". */
export function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(blank)";
  return String(v);
}

/**
 * Diff plain scalar fields between an old and a new object. Returns one
 * record per field that actually changed. Field labels are the object
 * keys; callers may pass a label map for friendlier names.
 */
export function diffFields(
  ctx: AuditContext,
  oldObj: object | null | undefined,
  newObj: object,
  fields: string[],
  labels?: Record<string, string>,
): AuditEntry[] {
  const out: AuditEntry[] = [];
  const oldRec = oldObj as Record<string, unknown> | null | undefined;
  const newRec = newObj as Record<string, unknown>;
  for (const f of fields) {
    const oldV = oldRec ? oldRec[f] : undefined;
    const newV = newRec[f];
    if (oldV === newV) continue;
    // Arrays/objects are compared by content, not reference.
    if (
      typeof oldV === "object" &&
      typeof newV === "object" &&
      JSON.stringify(oldV) === JSON.stringify(newV)
    ) {
      continue;
    }
    out.push(entry(ctx, labels?.[f] ?? f, fmtVal(oldV), fmtVal(newV)));
  }
  return out;
}

export interface DocLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Diff line items (estimate/invoice lines) line by line, so a quantity
 * edited from 1 to 2 is recorded as exactly that — not as a whole
 * document blob changing. Added lines log as "(line added)", removed
 * lines as "(line removed)".
 */
export function diffLines(
  ctx: AuditContext,
  oldLines: DocLine[],
  newLines: DocLine[],
): AuditEntry[] {
  const out: AuditEntry[] = [];
  const oldById = new Map(oldLines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  for (const nl of newLines) {
    seen.add(nl.id);
    const ol = oldById.get(nl.id);
    if (!ol) {
      out.push(
        entry(
          ctx,
          "(line added)",
          "",
          `${nl.description || "(no description)"} × ${nl.quantity} @ ${nl.unitPrice}`,
        ),
      );
      continue;
    }
    const label = `line "${ol.description || nl.description || "(no description)"}"`;
    if (ol.description !== nl.description) {
      out.push(
        entry(ctx, `${label} description`, fmtVal(ol.description), fmtVal(nl.description)),
      );
    }
    if (ol.quantity !== nl.quantity) {
      out.push(
        entry(ctx, `${label} quantity`, fmtVal(ol.quantity), fmtVal(nl.quantity)),
      );
    }
    if (ol.unitPrice !== nl.unitPrice) {
      out.push(
        entry(ctx, `${label} unit price`, fmtVal(ol.unitPrice), fmtVal(nl.unitPrice)),
      );
    }
  }
  for (const ol of oldLines) {
    if (!seen.has(ol.id)) {
      out.push(
        entry(
          ctx,
          "(line removed)",
          `${ol.description || "(no description)"} × ${ol.quantity} @ ${ol.unitPrice}`,
          "",
        ),
      );
    }
  }
  return out;
}

/** Cap the log so it cannot grow without bound in this preview. */
export function appendAudit(
  log: AuditEntry[],
  entries: AuditEntry[],
): AuditEntry[] {
  if (entries.length === 0) return log;
  const next = [...log, ...entries];
  return next.length > 2000 ? next.slice(next.length - 2000) : next;
}

/**
 * Per-person crew changes on a job, so adding or removing someone logs
 * as its own record ("crew: added Miguel",
 * "crew: Aidan → removed") instead of a whole crew-list blob
 * changing. Callers pass display names, not ids.
 */
export function memberChangeEntries(
  ctx: AuditContext,
  added: string[],
  removed: string[],
): AuditEntry[] {
  return [
    ...added.map((name) => entry(ctx, "crew", "", `added ${name}`)),
    ...removed.map((name) => entry(ctx, "crew", name, "removed")),
  ];
}
