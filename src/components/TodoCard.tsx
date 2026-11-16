import { useEffect, useState } from "react";
import { useLoadedState, useStore } from "../store";
import { isOwnerLike } from "../permissions";
import { loadInvoiceReviews, type InvoiceReview } from "../autoInvoice";
import { loadHeldBatch, type HeldBatch } from "../automationStatus";
import { loadWeekApprovalsBefore, type WeekApproval } from "../weekApprovals";
import { acceptedOnline } from "../acceptedOnline";
import { openSalesBookings, openTimesheetsOnWeek } from "../viewHandoff";
import { buildTodo, todoCount, todoWeekMondays, topItems, type TodoAction, type TodoGroup, type TodoItem } from "../todo";
import { fmtDate, mondayOf } from "../utils";
import { businessToday } from "../overdueInvoice";
import InvoiceReviewList from "./InvoiceReviewList";
import JobsWithoutValue from "./JobsWithoutValue";
import { SuggestedChangesCard } from "./CustomerSuggestions";
import { CrewPriceChangesCard } from "./JobPriceChanges";
import { linkCls, secondaryBtn } from "./ui";

/** How many lines show before "Show all". */
const TOP = 5;

/**
 * Accepted online — call to schedule (moved here from the Dashboard so
 * it shows under the To-do's "Show all", with its Call and Schedule
 * buttons).
 */
function AcceptedOnlineCard() {
  const { openEstimate, setView } = useStore();
  const state = useLoadedState();
  const items = acceptedOnline(state.estimates, state.jobs, state.customers);
  if (items.length === 0) return null;
  return (
    <section className="rounded-xl border border-emerald-300 bg-white p-4 shadow-sm">
      <h2 className="text-base font-bold text-slate-900">Accepted online — call to schedule</h2>
      <p className="text-sm text-slate-600">
        These customers accepted their estimate on the online link. They were not emailed: call them to
        pick a day, then drag the estimate onto the day in Schedule → To schedule.
      </p>
      <ul className="mt-2 divide-y divide-slate-100 text-sm">
        {items.slice(0, 10).map((a) => (
          <li key={a.estimateId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span>
              <button onClick={() => openEstimate(a.estimateId)} className={linkCls()}>
                Accepted online — call to schedule: {a.customerName}
              </button>
              <span className="block text-xs text-slate-500">
                {a.what} · accepted {fmtDate(a.acceptedAt.slice(0, 10))}
              </span>
            </span>
            <span className="flex gap-2">
              {a.phone && (
                <a href={`tel:${a.phone}`} className={secondaryBtn()}>
                  📞 Call {a.phone}
                </a>
              )}
              <button onClick={() => setView("schedule")} className={secondaryBtn()}>
                Schedule it →
              </button>
            </span>
          </li>
        ))}
      </ul>
      {items.length > 10 && (
        <button
          onClick={() => setView("schedule")}
          className="mt-2 text-sm font-semibold text-emerald-700 hover:underline"
        >
          {items.length - 10} more in Schedule → To schedule →
        </button>
      )}
    </section>
  );
}

/** Groups whose full working card (with its own buttons) shows under "Show all". */
function WorkingCard({ group }: { group: TodoGroup }) {
  switch (group.kind) {
    case "invoiceReview":
      return <InvoiceReviewList />;
    case "noValue":
      return <JobsWithoutValue />;
    case "acceptedOnline":
      return <AcceptedOnlineCard />;
    case "suggestion":
      return <SuggestedChangesCard />;
    case "priceChange":
      return <CrewPriceChangesCard />;
    default:
      return null;
  }
}
const HAS_CARD = new Set(["invoiceReview", "noValue", "acceptedOnline", "suggestion", "priceChange"]);

function TodoLine({ item }: { item: TodoItem }) {
  const { openJob, openEstimate, openCustomer, openInvoice, setView } = useStore();
  const go = (a: TodoAction) => {
    switch (a.kind) {
      case "job":
        return openJob(a.id, a.edit ? { edit: true } : undefined);
      case "estimate":
        return openEstimate(a.id);
      case "customer":
        return openCustomer(a.id);
      case "invoice":
        return openInvoice(a.id);
      case "view":
        return setView(a.view);
      case "timesheetsWeek":
        openTimesheetsOnWeek(a.monday);
        return setView("timesheets");
      case "salesBookings":
        openSalesBookings();
        return setView("sales");
    }
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-semibold text-slate-900">{item.text}</span>
        {item.detail && <span className="block break-words text-xs text-slate-500">{item.detail}</span>}
      </span>
      <button onClick={() => go(item.action)} className={`${secondaryBtn()} min-h-11 shrink-0`}>
        {item.button}
      </button>
    </li>
  );
}

/**
 * Dashboard "To-do" (office staff): counts plus the top 5 things that
 * need a person, each with a button that opens it; "Show all" lists
 * everything, with the working cards (Make invoice, Approve, Mark seen…).
 */
export default function TodoCard() {
  const { role, viewer, showMoney, canEdit } = useStore();
  const state = useLoadedState();
  const staff = role !== "crew";
  const admin = isOwnerLike(viewer?.appRole);
  // The company's calendar day (Denver), for overdue invoices and weeks.
  const today = businessToday();
  const thisMonday = mondayOf(today);
  const [showAll, setShowAll] = useState(false);
  const [reviews, setReviews] = useState<InvoiceReview[]>([]);
  const [held, setHeld] = useState<HeldBatch | null>(null);
  const [weeks, setWeeks] = useState<Record<string, WeekApproval> | undefined>(undefined);

  // Loaded on demand, like the cards they come from; reloaded when the
  // data they depend on changes (a teammate's Done, an invoice made).
  useEffect(() => {
    if (!staff) return;
    let live = true;
    void loadInvoiceReviews().then((r) => live && setReviews(r));
    return () => {
      live = false;
    };
  }, [staff, state.jobs, state.invoices]);
  useEffect(() => {
    if (!staff) return;
    let live = true;
    void loadHeldBatch().then((b) => live && setHeld(b));
    return () => {
      live = false;
    };
  }, [staff, state.settings]);
  useEffect(() => {
    if (!admin) return;
    let live = true;
    // Not loaded (offline): no week lines rather than wrong ones.
    void loadWeekApprovalsBefore(thisMonday, todoWeekMondays(today)[0]).then((a) => live && setWeeks(a ?? undefined));
    return () => {
      live = false;
    };
  }, [admin, thisMonday, state.timesheets]);

  if (!staff) return null;
  const groups = buildTodo({
    state,
    today,
    staff,
    admin,
    showMoney,
    canEdit,
    invoiceReviews: reviews,
    heldBatch: held,
    weekApprovals: admin ? weeks : undefined,
  });
  const total = todoCount(groups);

  return (
    <section className="rounded-xl border border-amber-300 bg-white p-4 shadow-sm" aria-label="To-do">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-bold text-slate-900">
          To-do{" "}
          {total > 0 && (
            <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-sm font-bold text-amber-900">{total}</span>
          )}
        </h2>
        {(total > TOP || groups.some((g) => HAS_CARD.has(g.kind))) && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="min-h-11 text-sm font-semibold text-emerald-700 hover:underline"
          >
            {showAll ? "Show less" : total > TOP ? `Show all ${total}` : "Show details"}
          </button>
        )}
      </div>
      {total === 0 ? (
        <p className="mt-1 text-sm text-slate-500">Nothing needs you right now.</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-slate-600">{groups.map((g) => g.label).join(" · ")}</p>
          {!showAll ? (
            <ul className="mt-1 divide-y divide-slate-100">
              {topItems(groups, TOP).map((i) => (
                <TodoLine key={i.key} item={i} />
              ))}
            </ul>
          ) : (
            <div className="mt-2 space-y-4">
              {groups.map((g) =>
                HAS_CARD.has(g.kind) ? (
                  <WorkingCard key={g.kind} group={g} />
                ) : (
                  <div key={g.kind}>
                    <h3 className="text-sm font-bold capitalize text-slate-800">{g.label}</h3>
                    <ul className="divide-y divide-slate-100">
                      {g.items.map((i) => (
                        <TodoLine key={i.key} item={i} />
                      ))}
                    </ul>
                  </div>
                ),
              )}
              <button onClick={() => setShowAll(false)} className="text-sm font-semibold text-emerald-700 hover:underline">
                Show less
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
