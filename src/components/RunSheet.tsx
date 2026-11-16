import { useStore } from "../store";
import { crewDayJobs, dayCrewJobs } from "../crewSuggest";
import { jobAddress as sharedJobAddress } from "../scheduling";
import { jobValue } from "../jobValue";
import { fmtDateLong, money } from "../utils";
import { formatLegText, useRouteLegs } from "./DayItinerary";
import Login from "./Login";
import PendingApproval from "./PendingApproval";
import TwoStepCode from "./TwoStepCode";

/**
 * Printable run sheet for one day crew — part 2 of the day plan.
 *
 * A standalone route (#/runsheet/:date/:crewId) that renders only
 * the sheet plus a Print button: no app header or nav, so the
 * printed page is clean US Letter. The crew lead opens it from
 * their phone (the "Print run sheet" link on a crew card) and
 * prints it, or just reads it on the phone.
 *
 * The sheet reuses DayItinerary's stop ordering and drive legs
 * (useRouteLegs) — the sheet and the screen never disagree about
 * the route. Contents: date, crew name and members; one numbered
 * stop per job in time order (start time, customer name + phone,
 * address, title + service type, customer/team notes, drive time
 * from the previous stop); the equipment the crew's jobs need that
 * day; job count and the crew's day total (money only when the
 * viewer can see it). Office notes are never on the sheet — they
 * are office-only. No new data: it reads the same state the app
 * already has.
 *
 * Permissions are the same as the rest of the app: owners/office
 * see a crew's full route; a crew member sees only the crews they
 * belong to, and only their own stops on them — never another
 * crew's jobs.
 */

/** Deep link to a crew's run sheet. Opens in a new tab so the app tab stays put. */
export function runSheetUrl(date: string, crewId: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/runsheet/${date}/${encodeURIComponent(crewId)}`;
}

function parseHash(): { date: string; crewId: string } | null {
  const m = window.location.hash.match(/^#\/runsheet\/([^/]+)\/(.+)$/);
  if (!m) return null;
  try {
    return {
      date: decodeURIComponent(m[1]),
      crewId: decodeURIComponent(m[2]),
    };
  } catch {
    return null;
  }
}

export default function RunSheet() {
  const {
    state,
    loading,
    viewerId,
    canSeeAllJobs,
    showMoney,
    supabaseMode,
    authUser,
    authLoading,
    accessStatus,
    twoStep,
  } = useStore();

  // Plain computation first (no hooks below this point depend on
  // state being loaded), then the shared route hook, then the gates.
  const params = parseHash();
  const crew =
    state && params
      ? (state.dayCrews ?? []).find((c) => c.id === params.crewId) ?? null
      : null;
  // Owners/office see the crew's full route; a crew member sees
  // only their own stops on a crew they belong to.
  const stops =
    state && crew
      ? canSeeAllJobs
        ? dayCrewJobs(state, crew.date, crew.memberIds)
        : crewDayJobs(state, crew.date, viewerId)
      : [];
  const { ordered, legs } = useRouteLegs(stops);

  // Same gates as the app shell: nobody sees a sheet without a
  // signed-in, approved account.
  if (supabaseMode && authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <p className="text-slate-500">Loading run sheet…</p>
      </div>
    );
  }
  if (supabaseMode && !authUser) {
    return <Login />;
  }
  // Two-step login: the code comes first (the database shows no
  // company data until then).
  if (supabaseMode && twoStep === "needed") {
    return <TwoStepCode />;
  }
  if (supabaseMode && accessStatus === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <p className="text-slate-500">Loading run sheet…</p>
      </div>
    );
  }
  if (supabaseMode && accessStatus === "pending") {
    return <PendingApproval />;
  }
  if (loading || !state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white">
        <p className="text-slate-500">Loading run sheet…</p>
      </div>
    );
  }

  const backHref = window.location.pathname;

  if (!params || !crew) {
    return (
      <div className="min-h-screen bg-white">
        <div className="mx-auto max-w-2xl px-4 py-6">
          <p className="text-sm font-bold text-slate-900">
            Run sheet not found
          </p>
          <p className="mt-1 text-sm text-slate-600">
            That crew or date doesn&apos;t exist any more — the crew may
            have been deleted. Go back and open the sheet from the
            crew&apos;s card.
          </p>
          <a
            href={backHref}
            className="mt-4 inline-block text-sm font-semibold text-emerald-700 underline"
          >
            ← Back to the app
          </a>
        </div>
      </div>
    );
  }

  if (!canSeeAllJobs && !crew.memberIds.includes(viewerId)) {
    return (
      <div className="min-h-screen bg-white">
        <div className="mx-auto max-w-2xl px-4 py-6">
          <p className="text-sm font-bold text-slate-900">
            Run sheet — {fmtDateLong(crew.date)}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            This run sheet is for {crew.name}, and you&apos;re not on
            that crew — so there&apos;s nothing to show here. Your own
            crew&apos;s sheet is on your Today page.
          </p>
          <a
            href={backHref}
            className="mt-4 inline-block text-sm font-semibold text-emerald-700 underline"
          >
            ← Back to the app
          </a>
        </div>
      </div>
    );
  }

  const memberNames = crew.memberIds
    .map((id) => state.crew.find((c) => c.id === id)?.name)
    .filter(Boolean);
  const equipmentNames = Array.from(
    new Set(ordered.flatMap((j) => j.equipmentIds)),
  )
    .map((id) => state.equipment.find((e) => e.id === id)?.name)
    .filter(Boolean);
  const values = ordered
    .map((j) => jobValue(state, j))
    .filter((v): v is number => v !== null);
  const dayTotal = values.reduce((a, b) => a + b, 0);
  const jobAddress = (j: (typeof ordered)[number]): string | null =>
    sharedJobAddress(state, j);
  const dirStops = ordered.map((j) => {
    if (j.lat !== null && j.lng !== null) return `${j.lat},${j.lng}`;
    return jobAddress(j) ?? "";
  });
  const directionsUrl = `https://www.google.com/maps/dir/${dirStops
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/")}`;

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <style>{`@media print { .runsheet-no-print { display: none !important; } @page { size: Letter; margin: 12mm; } }`}</style>
      <div className="mx-auto max-w-2xl px-4 py-6">
        <div className="runsheet-no-print flex flex-wrap items-center justify-between gap-2">
          <a
            href={backHref}
            className="text-sm font-semibold text-emerald-700 underline"
          >
            ← Back to the app
          </a>
          <button
            onClick={() => window.print()}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white"
          >
            🖨 Print
          </button>
        </div>

        <header className="mt-4 border-b-2 border-slate-900 pb-3">
          <p className="text-xs font-bold uppercase tracking-widest text-slate-500">
            Run sheet
          </p>
          <h1 className="text-2xl font-bold">{fmtDateLong(crew.date)}</h1>
          <p className="text-lg font-bold">{crew.name}</p>
          <p className="text-sm text-slate-600">
            {memberNames.length > 0
              ? memberNames.join(", ")
              : "No members yet"}
          </p>
        </header>

        {ordered.length === 0 ? (
          <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            No jobs on this crew&apos;s sheet for {fmtDateLong(crew.date)}.
            Nothing is scheduled for {crew.name} that day.
          </p>
        ) : (
          <>
            <a
              href={directionsUrl}
              target="_blank"
              rel="noreferrer"
              className="runsheet-no-print mt-3 inline-block text-sm font-semibold text-emerald-700 underline"
            >
              Directions for the whole route →
            </a>
            <ol className="mt-3 space-y-4">
              {ordered.map((j, i) => {
                const c = state.customers.find(
                  (x) => x.id === j.customerId,
                );
                const customerName = c
                  ? `${c.firstName} ${c.lastName}`.trim() ||
                    c.company ||
                    "Unknown customer"
                  : "Unknown customer";
                const address = jobAddress(j) ?? "Unknown address";
                const leg = i < ordered.length - 1 ? legs[i] : null;
                const phone = c?.phone?.trim() ?? "";
                return (
                  <li key={j.id}>
                    <div className="flex gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-bold">
                          {j.startTime} — {j.title}
                        </p>
                        <p className="text-sm text-slate-600">
                          {j.serviceType}
                        </p>
                        <p className="text-sm">
                          {customerName}
                          {phone && (
                            <>
                              {" · "}
                              <a
                                href={`tel:${phone.replace(/[^0-9+]/g, "")}`}
                                className="font-semibold text-emerald-700 underline"
                              >
                                {phone}
                              </a>
                            </>
                          )}
                        </p>
                        <p className="text-sm text-slate-600">{address}</p>
                        {j.customerNotes.trim() && (
                          <p className="mt-1 text-sm">
                            <span className="font-semibold">
                              Customer notes:{" "}
                            </span>
                            {j.customerNotes}
                          </p>
                        )}
                        {j.teamNotes.trim() && (
                          <p className="mt-1 text-sm">
                            <span className="font-semibold">
                              Team notes:{" "}
                            </span>
                            {j.teamNotes}
                          </p>
                        )}
                      </div>
                    </div>
                    {leg !== null && (
                      <p className="py-1 pl-11 text-sm font-semibold text-slate-500">
                        ↓ {formatLegText(leg)}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>

            <section className="mt-4 border-t border-slate-300 pt-3">
              <p className="text-sm">
                <span className="font-bold">Equipment: </span>
                {equipmentNames.length > 0
                  ? equipmentNames.join(", ")
                  : "No equipment listed for these jobs."}
              </p>
            </section>
          </>
        )}

        <footer className="mt-4 border-t-2 border-slate-900 pt-3">
          <p className="text-sm font-bold">
            {ordered.length} {ordered.length === 1 ? "job" : "jobs"}
            {showMoney && values.length > 0 &&
              ` · ${money(dayTotal)} total for the day`}
          </p>
        </footer>
      </div>
    </div>
  );
}
