import { useStore } from "../store";
import type { AuditEntry } from "../types";
import { canOpenJob } from "../jobVisibility";
import { fmtDateTime } from "../utils";
import { describeAudit } from "../auditText";
import { linkCls } from "./ui";

/**
 * Renders audit entries as a timeline: timestamp, who did it, and what
 * changed, in plain English ("Alex added the Chipper to Big oak", see
 * src/auditText.ts). Every reference to a record is clickable:
 * jobs open the job drawer, employees open the profile drawer,
 * customers open the customer drawer, estimates/invoices open their
 * editors, and a timesheet entry opens its employee's profile. Used on
 * customer profiles (full activity log) and on estimate/invoice detail
 * views (History). One exception: a job the viewer is not assigned to
 * (crew without the seeAllJobs override) renders as plain text, never
 * a link — the entry stays readable, the drawer stays closed.
 */
export default function AuditList({
  entries,
  emptyText,
}: {
  entries: AuditEntry[];
  emptyText: string;
}) {
  const {
    state,
    canSeeAllJobs,
    viewerId,
    openJob,
    openEmployee,
    openCustomer,
    openEstimate,
    openInvoice,
  } = useStore();

  const equipmentName = (id: string) =>
    state?.equipment.find((q) => q.id === id)?.name;
  // Plain-English lines (src/auditText.ts); rows where nothing really
  // changed are left out.
  const sorted = [...entries]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((e) => ({ e, s: describeAudit(e, { equipment: equipmentName }) }))
    .filter(({ s }) => !s.hidden);
  if (sorted.length === 0) {
    return <p className="text-sm text-slate-500">{emptyText}</p>;
  }

  /** Where this entry's record opens, or null when it names no record. */
  const targetFor = (e: AuditEntry): (() => void) | null => {
    if (!state) return null;
    switch (e.entity) {
      case "Job":
        // Crew job rule (see src/jobVisibility.ts): an entry about a
        // job the viewer cannot open is plain text, not a link — so a
        // feed entry that stays visible via the worked-week rule can
        // never tap through to an unassigned job's drawer. The
        // store's openJob gate is the backstop for any other caller.
        return canOpenJob(state, e.entityId, viewerId, canSeeAllJobs)
          ? () => openJob(e.entityId)
          : null;
      case "User":
        return state.crew.some((c) => c.id === e.entityId)
          ? () => openEmployee(e.entityId)
          : null;
      case "Customer":
        return state.customers.some((c) => c.id === e.entityId)
          ? () => openCustomer(e.entityId)
          : null;
      case "Estimate":
        return state.estimates.some((x) => x.id === e.entityId)
          ? () => openEstimate(e.entityId)
          : null;
      case "Invoice":
        return state.invoices.some((x) => x.id === e.entityId)
          ? () => openInvoice(e.entityId)
          : null;
      case "Note":
        return e.customerId ? () => openCustomer(e.customerId as string) : null;
      case "Message":
        return e.customerId ? () => openCustomer(e.customerId as string) : null;
      case "Timesheet": {
        const t = state.timesheets.find((x) => x.id === e.entityId);
        return t ? () => openEmployee(t.crewId) : null;
      }
      default:
        return null;
    }
  };

  const actorTarget = (actor: string): (() => void) | null => {
    if (!state) return null;
    const member = state.crew.find((c) => c.name === actor);
    return member ? () => openEmployee(member.id) : null;
  };

  return (
    <ul className="space-y-2">
      {sorted.map(({ e, s }) => {
        const target = targetFor(e);
        const actorOpen = actorTarget(e.actor);
        return (
          <li
            key={e.id}
            className="border-b border-slate-100 pb-2 text-sm last:border-0"
          >
            <p className="text-slate-900">
              {actorOpen ? (
                <button onClick={actorOpen} className={linkCls()}>
                  {e.actor}
                </button>
              ) : (
                <span className="font-semibold">{e.actor}</span>
              )}{" "}
              {s.lead}{" "}
              {target ? (
                <button onClick={target} className={linkCls()}>
                  {s.label}
                </button>
              ) : (
                <span className="font-medium">{s.label}</span>
              )}
              {s.tail}
            </p>
            <p className="text-xs text-slate-500">
              {fmtDateTime(e.timestamp)}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
