import { useEffect, useRef, useState } from "react";
import Activity from "./components/Activity";
import Automations from "./components/Automations";
import CrewView from "./components/CrewView";
import CustomerPortal from "./components/CustomerPortal";
import Customers from "./components/Customers";
import Dashboard from "./components/Dashboard";
import DetailDrawers from "./components/DetailDrawers";
import InvoiceComposer from "./components/InvoiceComposer";
import { setComposeOwner } from "./invoiceCompose";
import FlashBar from "./components/FlashBar";
import UrlSync from "./components/UrlSync";
import AskAI from "./components/AskAI";
import CrewMeMenu from "./components/CrewMeMenu";
import SaveBanner from "./components/SaveBanner";
import Estimates from "./components/Estimates";
import EquipmentPage from "./components/Equipment";
import FieldGuide from "./components/FieldGuide";
import Invoices from "./components/Invoices";
import SalesCalendar from "./components/SalesCalendar";
import Login from "./components/Login";
import SetNewPassword from "./components/SetNewPassword";
import { usePasswordRecovery } from "./passwordReset";
import SetupWizard from "./components/SetupWizard";
import { isCompanyConfigured, companyLogoSrc, companyName } from "./company";
import AcceptEstimate from "./components/AcceptEstimate";
import { acceptTokenFromPath } from "./estimateSend";
import BookEstimate from "./components/BookEstimate";
import RunSheet from "./components/RunSheet";
import Messages from "./components/Messages";
import PendingApproval from "./components/PendingApproval";
import TwoStepCode from "./components/TwoStepCode";
import TwoStepSettings from "./components/TwoStepSettings";
import Phc from "./components/Phc";
import Pipeline from "./components/Pipeline";
import Schedule from "./components/Schedule";
import Timesheets from "./components/Timesheets";
import Tour from "./components/Tour";
import Users from "./components/Users";
import CrewRules from "./components/CrewRules";
import LicencesInsurance from "./components/LicencesInsurance";
import MePage from "./components/MePage";
import { AppProvider, useStore } from "./store";
import type { View } from "./store";
import type { Role } from "./types";
import { accessNote, isOwnerLike, isSalesTitle, redirectToToday } from "./permissions";
import { unseenEquipmentNoteCount } from "./equipmentNotesSeen";
import { pendingBookingCount } from "./salesQueue";
import {
  applyNavOrder,
  clearNavOrder,
  isClickSuppressed,
  loadNavOrder,
  moveIdInOrder,
  nudgeIdInOrder,
  saveNavOrder,
} from "./navOrder";
import {
  fieldGroupsFor,
  OFFICE_GROUPS,
  buildNav,
  groupForView,
  viewForGroup,
  viewLabel,
} from "./navGroups";

const ALL_VIEWS: Array<{ id: View; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "customers", label: "Customers" },
  { id: "schedule", label: "Schedule" },
  { id: "pipeline", label: "Pipeline" },
  { id: "phc", label: "Plant Health Care" },
  { id: "estimates", label: "Estimates" },
  { id: "invoices", label: "Invoices" },
  { id: "timesheets", label: "Timesheets" },
  { id: "automations", label: "Automations" },
  { id: "activity", label: "Activity" },
  { id: "messages", label: "Messages" },
  { id: "crew", label: "Today" },
  { id: "guide", label: "Field Guide" },
  { id: "sales", label: "Sales" },
  { id: "equipment", label: "Equipment" },
  { id: "crew-rules", label: "Crew Rules" },
  { id: "documents", label: "Licences & insurance" },
  { id: "portal", label: "Customer Portal" },
  { id: "users", label: "Team" },
  { id: "me", label: "Me" },
];

/**
 * Navigation by permission, not by stand-in role: admins see
 * everything; climbers (editors) see everything except user
 * administration, which stays admin-only — the admin manages all
 * logins and profiles; groundsmen (read-only) get their own day, the
 * schedule, their timesheets, and the Activity page — they can still
 * reach any other record read-only through the drawers.
 */
const FIELD_VIEWS: View[] = [
  "dashboard",
  "schedule",
  "timesheets",
  "activity",
  "messages",
  "crew",
  "guide",
  "equipment",
];

/** Phone grid columns for the main tab row (literal class names for Tailwind). */
const PHONE_COLS: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  5: "grid-cols-5",
};

/**
 * Columns for the phone tab grid: every label must fit a ~390px phone
 * without being cut off, so 5 buttons go 3 + 2 and 6–8 go in rows of 4.
 */
function phoneCols(n: number): number {
  if (n <= 4) return n;
  if (n <= 6) return 3;
  return 4;
}

function viewsFor(
  canEdit: boolean,
  isAdmin: boolean,
  appRole: Role,
  canSeeMoney: boolean,
  isSales = false,
): Array<{ id: View; label: string }> {
  if (isAdmin) return ALL_VIEWS.filter((v) => v.id !== "me");
  // App role Crew: the database only returns their own jobs and those
  // jobs' customers (and estimates/invoices only with "see money"),
  // so show just the tabs that have data for them — a Climber edits
  // their jobs from Schedule / Today, not from the office tabs.
  const crewViews: View[] = [
    ...FIELD_VIEWS,
    "me",
    "customers",
    ...(canSeeMoney ? (["estimates", "invoices"] as View[]) : []),
    // A Sales person (job title "Sales") books estimate visits and
    // writes draft estimates; the database allows exactly that
    // (is_sales_person).
    ...(isSales ? (["sales", "estimates"] as View[]) : []),
  ];
  const list =
    appRole === "crew"
      ? ALL_VIEWS.filter((v) => crewViews.includes(v.id))
      : canEdit
        ? ALL_VIEWS.filter(
            (v) => v.id !== "users" && v.id !== "crew-rules" && v.id !== "me",
          )
        : ALL_VIEWS.filter((v) => [...FIELD_VIEWS, "me"].includes(v.id));
  // The crew's day comes first: Today is their landing page, and the
  // full month stays one tap away on Schedule. The office starts on
  // the Dashboard like owners.
  if (canEdit) return list;
  const today = list.find((v) => v.id === "crew");
  return today ? [today, ...list.filter((v) => v.id !== "crew")] : list;
}

function Shell() {
  const {
    state,
    loading,
    role,
    view,
    setView,
    resetDemo,
    viewerId,
    viewer,
    openEmployee,
    setViewerId,
    canEdit,
    canEditJobs,
    canSeeMoney,
    supabaseMode,
    authUser,
    authLoading,
    accessStatus,
    signOut,
    loadError,
    reloadState,
    saveStatus,
    saveFailedTable,
    saveMigrationHint,
    retrySave,
    saveRefused,
    clearSaveRefused,
    jobAccessDenied,
    clearJobAccessDenied,
    twoStep,
  } = useStore();
  const [showTwoStep, setShowTwoStep] = useState(false);
  // The New invoice pop-up keeps its draft per signed-in person; a
  // signed-out viewer keeps nothing (src/invoiceCompose.ts).
  const composeOwner = supabaseMode ? (authUser?.id ?? null) : (viewer?.id ?? null);
  useEffect(() => {
    setComposeOwner(composeOwner);
  }, [composeOwner]);
  // Arrived from the "Forgot password?" email link.
  const recoveringPassword = usePasswordRecovery();
  const [tourOpen, setTourOpen] = useState(false);
  // Crew phones: account buttons live behind one "Me" menu.
  const crewMenu = supabaseMode && role === "crew";

  // Reorderable nav tabs: each person drags their own tabs into
  // their own order, saved per person in localStorage — the same
  // pattern as the dashboard layout (`dashboard-layout-<viewerId>`).
  // The key follows the signed-in person, so switching "Viewing as"
  // in demo mode reloads that person's order.
  const navOrderKey = `nav-order-${viewer?.id ?? "shared"}`;
  const [navOrder, setNavOrder] = useState<string[]>(() =>
    loadNavOrder(localStorage, navOrderKey),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [reorderingNav, setReorderingNav] = useState(false);
  // A drag's own mouse-up must not also count as a tap on the tab.
  const lastDragEndRef = useRef(0);
  useEffect(() => {
    setNavOrder(loadNavOrder(localStorage, navOrderKey));
  }, [navOrderKey]);

  // Crew land on Today, not the Dashboard: in Supabase mode (real
  // logins) a crew login whose view is still the default gets moved to
  // Today once per page load. Owners, managers and the office keep the
  // Dashboard landing, and anyone can still open the Dashboard from the nav
  // afterwards.
  const todayRedirected = useRef(false);
  // The "More" menu: open/closed, closes with Escape.
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);
  // The sub-screen each person last used inside a main tab (Sales →
  // Pipeline), so tapping the tab again goes back there.
  const [lastInGroup, setLastInGroup] = useState<Record<string, View>>({});
  useEffect(() => {
    if (
      supabaseMode &&
      accessStatus === "active" &&
      viewer &&
      redirectToToday(viewer.appRole, view, todayRedirected.current)
    ) {
      todayRedirected.current = true;
      setView("crew");
    }
  }, [supabaseMode, accessStatus, viewer, view, setView]);

  // Supabase mode gates on the session first: no session, login
  // screen; session but no data yet, loading (or the load error).
  // Mock mode keeps the old behavior exactly.
  if (supabaseMode && authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500">Loading…</p>
      </div>
    );
  }

  if (supabaseMode && !authUser) {
    return <Login />;
  }

  // Two-step login: the code from the authenticator app comes before
  // anything else (the database shows no company data until then).
  // Also before setting a new password from a reset link: with two-step
  // login on, the password can only be changed once the code is entered.
  if (supabaseMode && twoStep === "needed") {
    return <TwoStepCode />;
  }
  if (supabaseMode && twoStep === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500">Loading…</p>
      </div>
    );
  }

  if (supabaseMode && recoveringPassword) {
    return <SetNewPassword />;
  }

  // Signed in but no membership yet: waiting for an owner to approve
  // the login. Never show the app shell to a pending user.
  if (supabaseMode && accessStatus === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500">Loading…</p>
      </div>
    );
  }

  if (supabaseMode && accessStatus === "pending") {
    return <PendingApproval />;
  }

  if (supabaseMode && loadError && !loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="font-bold text-slate-900">
            Could not load company data
          </p>
          <p className="mt-1 text-sm text-slate-500">{loadError}</p>
          <button
            onClick={reloadState}
            className="mt-4 w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white"
          >
            Try again
          </button>
          <button
            onClick={() => void signOut()}
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (loading || !state) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-500">Loading…</p>
      </div>
    );
  }

  // First-run setup: no company profile yet, so the wizard asks for
  // the business details before the app can be used. Only an owner
  // (or the preview viewer, who is the owner by default) completes
  // it; anyone else waits for the owner to finish setup.
  if (state && !isCompanyConfigured(state.settings)) {
    if (!isOwnerLike(role)) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="text-lg font-bold text-slate-900">
              🌲 Setting up
            </p>
            <p className="mt-1 text-sm text-slate-500">
              The owner hasn&apos;t finished setting up this business
              yet. Check back once they have — you&apos;ll see the
              schedule then.
            </p>
          </div>
        </div>
      );
    }
    return <SetupWizard />;
  }

  // Which screens this person may see, arranged into a short row of
  // main tabs (a different row for crew) and a "More" menu. The saved
  // order applies to the main tabs this person is allowed to see: a
  // crew member can never gain an owner tab by reordering, and tabs a
  // role can't see are simply skipped.
  const isSales = isSalesTitle(viewer?.role);
  const allowedIds: View[] = viewsFor(
    canEdit,
    isOwnerLike(role),
    role,
    canSeeMoney,
    isSales,
  ).map((v) => v.id);
  const fieldLayout = role === "crew" || (!canEdit && !isOwnerLike(role));
  const layout = buildNav(
    allowedIds,
    fieldLayout ? fieldGroupsFor(isSales) : OFFICE_GROUPS,
  );
  const views = applyNavOrder(layout.main, navOrder);
  const activeView: View = allowedIds.includes(view)
    ? view
    : allowedIds.includes("dashboard")
      ? "dashboard"
      : (allowedIds[0] ?? "dashboard");
  const activeGroup = groupForView(layout, activeView);
  const openView = (v: View) => {
    // Any screen chosen on purpose (a tab, or an address from a link or a
    // reload via UrlSync) wins over the "crew land on Today" redirect.
    // UrlSync calls this before the redirect effect runs in the same
    // commit, so the redirect then does nothing.
    todayRedirected.current = true;
    const g = groupForView(layout, v);
    if (g) setLastInGroup((prev) => ({ ...prev, [g.id]: v }));
    setView(v);
    setMoreOpen(false);
  };
  // Red count badges: signups waiting (People) and equipment notes the
  // crew left since this manager last opened Equipment.
  const pendingSignups = state.crew.filter((c) => c.status === "pending").length;
  const equipmentNotes = unseenEquipmentNoteCount(state, viewer);
  // Booking requests from the website, for the office (Sales tab).
  const bookingsWaiting = canEdit ? pendingBookingCount(state) : 0;
  const badgeFor = (v: string) =>
    v === "users"
      ? pendingSignups
      : v === "equipment"
        ? equipmentNotes
        : v === "sales"
          ? bookingsWaiting
          : 0;
  const moreBadge = layout.more.reduce((n, v) => n + badgeFor(v), 0);
  const moreActive = activeGroup === null;
  // Save a new order for the visible tabs, keeping any saved ids
  // that aren't visible right now (e.g. an owner tab while viewing
  // as crew) at the end so they aren't lost.
  const persistNavOrder = (nextVisible: string[]) => {
    const kept = navOrder.filter((id) => !nextVisible.includes(id));
    const next = [...nextVisible, ...kept];
    setNavOrder(next);
    saveNavOrder(localStorage, navOrderKey, next);
  };
  const visibleIds = views.map((v) => v.id);
  const onNavDragStart =
    (id: string) => (e: React.DragEvent) => {
      setDragId(id);
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
    };
  const onNavDragOver =
    (id: string) => (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropId !== id) setDropId(id);
    };
  const onNavDrop =
    (id: string) => (e: React.DragEvent) => {
      e.preventDefault();
      const dragged = e.dataTransfer.getData("text/plain") || dragId || "";
      if (dragged) {
        persistNavOrder(moveIdInOrder(visibleIds, dragged, id));
      }
      setDragId(null);
      setDropId(null);
    };
  const onNavDragEnd = () => {
    setDragId(null);
    setDropId(null);
    lastDragEndRef.current = Date.now();
  };
  // Arrow nudge: dragging doesn't work on a phone, so in reorder
  // mode each tab also gets ◀ ▶ buttons — the same fallback the
  // dashboard layout uses.
  const nudgeNavTab = (id: string, dir: -1 | 1) => {
    persistNavOrder(nudgeIdInOrder(visibleIds, id, dir));
  };
  const resetNavOrder = () => {
    clearNavOrder(localStorage, navOrderKey);
    setNavOrder([]);
  };
  // Managers see the whole team, like owners; everyone else is scoped
  // to their own calendar, day, and timesheets (other records stay
  // reachable read-only through the drawers).
  const effectiveCrewId = isOwnerLike(role) ? null : viewerId || null;
  // Migration number for the header retry button, when the last save
  // failed on a missing column/table (e.g. "020").
  const saveMigrationNumber =
    saveMigrationHint?.match(/migration (\d+)/)?.[1] ?? null;

  return (
    <div className="min-h-screen bg-slate-50">
      {showTwoStep && <TwoStepSettings onClose={() => setShowTwoStep(false)} />}
      <SaveBanner />
      {saveRefused && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-3">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-amber-800">
              🔒 {saveRefused}
            </p>
            <button
              onClick={clearSaveRefused}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-semibold text-amber-800"
            >
              OK
            </button>
          </div>
        </div>
      )}
      {jobAccessDenied && (
        <div className="border-b border-amber-300 bg-amber-50 px-4 py-3">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-amber-800">
              🔒 You can&apos;t open &ldquo;{jobAccessDenied}&rdquo; —
              you&apos;re not assigned to that job. Only the crew on a
              job can open it.
            </p>
            <button
              onClick={clearJobAccessDenied}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-semibold text-amber-700"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <img
              src={companyLogoSrc(state)}
              alt={`${companyName(state)} logo`}
              className="h-9 w-9 rounded-full object-cover"
            />
            <div>
              <p className="text-lg font-bold leading-tight text-slate-900">
                {companyName(state)}
              </p>
              {!supabaseMode && (
                <p className="text-xs text-slate-500">
                  Preview — data stays in this browser
                </p>
              )}
            </div>
          </div>
          {!crewMenu && (
          <button
            onClick={() => setTourOpen(true)}
            className="rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            Take the tour
          </button>
          )}
          {crewMenu ? (
            <CrewMeMenu onTour={() => setTourOpen(true)} onTwoStep={() => setShowTwoStep(true)} />
          ) : supabaseMode ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-600">
                Signed in as{" "}
                {viewer && !viewer.id.startsWith("auth:") ? (
                  <button
                    type="button"
                    onClick={() => openEmployee(viewer.id)}
                    title="Your profile and settings"
                    className="font-semibold text-slate-900 underline decoration-dotted underline-offset-2 hover:text-emerald-800"
                  >
                    {authUser?.email}
                  </button>
                ) : (
                  <span className="font-semibold text-slate-900">
                    {authUser?.email}
                  </span>
                )}
              </span>
              {saveStatus === "saving" && (
                <span className="text-xs font-semibold text-slate-500">
                  Saving…
                </span>
              )}
              {saveStatus === "saved" && (
                <span className="text-xs font-semibold text-emerald-700">
                  ✓ Saved
                </span>
              )}
              {saveStatus === "error" && (
                <button
                  onClick={retrySave}
                  className="rounded-lg bg-red-100 px-3 py-2 text-sm font-bold text-red-800"
                >
                  Couldn&apos;t save
                  {saveFailedTable ? ` (${saveFailedTable})` : ""}
                  {saveMigrationNumber
                    ? ` — run migration ${saveMigrationNumber}`
                    : ""}
                  {" — tap to retry"}
                </button>
              )}
              <button
                onClick={() => setShowTwoStep(true)}
                className={`${fieldLayout ? "hidden sm:inline-block" : ""} rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-semibold text-slate-700`}
              >
                🔐 Two-step login
              </button>
              <button
                onClick={() => void signOut()}
                className={`${fieldLayout ? "hidden sm:inline-block" : ""} rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-semibold text-slate-700`}
              >
                Sign out
              </button>
              {accessNote(canEdit, canEditJobs) && (
                <span className="text-xs text-slate-500">
                  {accessNote(canEdit, canEditJobs)}
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Viewing as
              </label>
              <select
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm font-semibold"
                value={viewerId}
                onChange={(e) => setViewerId(e.target.value)}
                aria-label="Viewing as"
              >
                {state.crew.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.role}
                    {c.appRole === "owner"
                      ? " (admin)"
                      : c.appRole === "manager"
                        ? " (manager)"
                        : ""}
                  </option>
                ))}
              </select>
              {accessNote(canEdit, canEditJobs) && (
                <span className="text-xs text-slate-500">
                  {accessNote(canEdit, canEditJobs)}
                </span>
              )}
            </div>
          )}
        </div>
        <nav className="relative mx-auto max-w-7xl px-4 pb-2">
          {/* Phones: a grid of big buttons (nothing hidden off to the
              side). Laptops: one row that wraps instead of cutting off. */}
          <div
            className={`grid gap-1 ${
              PHONE_COLS[phoneCols(views.length + 1)] ?? "grid-cols-4"
            } sm:flex sm:flex-wrap sm:items-stretch`}
          >
            {views.map((g, i) => {
              const badge = g.views.reduce((n, v) => n + badgeFor(v), 0);
              const isActive = activeGroup?.id === g.id;
              return (
                <div
                  key={g.id}
                  draggable={reorderingNav}
                  onDragStart={onNavDragStart(g.id)}
                  onDragOver={onNavDragOver(g.id)}
                  onDrop={onNavDrop(g.id)}
                  onDragEnd={onNavDragEnd}
                  className={`flex min-w-0 items-center rounded-lg ${
                    dropId === g.id && dragId !== null && dragId !== g.id
                      ? "bg-emerald-50 ring-2 ring-emerald-600"
                      : ""
                  } ${dragId === g.id ? "opacity-40" : ""}`}
                >
                  {reorderingNav && (
                    <span
                      className="hidden cursor-grab select-none pl-1 text-slate-400 sm:inline"
                      title="Drag to move this tab"
                    >
                      ⋮⋮
                    </span>
                  )}
                  <button
                    onClick={() => {
                      // A drag's own mouse-up is not a tap.
                      if (isClickSuppressed(lastDragEndRef.current, Date.now()))
                        return;
                      openView(viewForGroup(g, lastInGroup[g.id]) as View);
                    }}
                    aria-current={isActive ? "page" : undefined}
                    className={`min-h-11 w-full min-w-0 truncate whitespace-nowrap rounded-lg px-1 py-2 sm:px-3 text-sm font-semibold ${
                      isActive
                        ? "bg-emerald-700 text-white"
                        : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {g.label}
                    {badge > 0 && (
                      <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">
                        {badge}
                      </span>
                    )}
                  </button>
                  {reorderingNav && (
                    <span className="flex flex-col pr-0.5 sm:flex-row">
                      <button
                        type="button"
                        aria-label={`Move ${g.label} left`}
                        disabled={i === 0}
                        onClick={() => nudgeNavTab(g.id, -1)}
                        className="min-h-6 rounded px-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-30 sm:min-h-11"
                      >
                        ◀
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${g.label} right`}
                        disabled={i === views.length - 1}
                        onClick={() => nudgeNavTab(g.id, 1)}
                        className="min-h-6 rounded px-1.5 text-xs font-bold text-slate-500 hover:bg-slate-100 disabled:opacity-30 sm:min-h-11"
                      >
                        ▶
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setMoreOpen((o) => !o)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              className={`min-h-11 min-w-0 truncate whitespace-nowrap rounded-lg px-1 py-2 text-sm font-semibold sm:px-3 ${
                moreActive
                  ? "bg-emerald-700 text-white"
                  : "border border-slate-300 text-slate-700 hover:bg-slate-100"
              }`}
            >
              {moreActive ? viewLabel(activeView) : "More"} ▾
              {moreBadge > 0 && (
                <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">
                  {moreBadge}
                </span>
              )}
            </button>
          </div>
          {reorderingNav && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <span className="flex-1">
                Drag the tabs, or use ◀ ▶, to put your daily tabs first.
              </span>
              <button
                onClick={resetNavOrder}
                disabled={navOrder.length === 0}
                className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 disabled:opacity-40"
              >
                ↺ Reset order
              </button>
              <button
                onClick={() => setReorderingNav(false)}
                className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white"
              >
                Done
              </button>
            </div>
          )}
          {moreOpen && (
            <>
              <div
                className="fixed inset-0 z-30"
                aria-hidden="true"
                onClick={() => setMoreOpen(false)}
              />
              <div
                role="menu"
                className="absolute left-4 right-4 top-full z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg sm:left-auto sm:w-72"
              >
                {layout.more.map((v) => {
                  const badge = badgeFor(v);
                  return (
                    <button
                      key={v}
                      role="menuitem"
                      onClick={() => openView(v as View)}
                      className={`flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left text-sm font-semibold ${
                        activeView === v
                          ? "bg-emerald-50 text-emerald-800"
                          : "text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      {viewLabel(v)}
                      {badge > 0 && (
                        <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[11px] font-bold leading-none text-white">
                          {badge}
                        </span>
                      )}
                    </button>
                  );
                })}
                <div className="my-1 border-t border-slate-100" />
                <button
                  role="menuitem"
                  onClick={() => {
                    setReorderingNav(true);
                    setMoreOpen(false);
                  }}
                  className="flex min-h-11 w-full items-center rounded-lg px-3 text-left text-sm text-slate-600 hover:bg-slate-100"
                >
                  ↕ Reorder tabs
                </button>
              </div>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-6 pt-6 sm:pb-24">
        {activeGroup?.subTabs && (
          <div className="-mt-2 mb-4 flex flex-wrap gap-1" role="tablist">
            {activeGroup.views.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={activeView === v}
                onClick={() => openView(v as View)}
                className={`min-h-11 rounded-full px-4 text-sm font-semibold ${
                  activeView === v
                    ? "bg-slate-900 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                }`}
              >
                {viewLabel(v)}
              </button>
            ))}
          </div>
        )}
        {activeView === "dashboard" && <Dashboard crewId={effectiveCrewId} />}
        {activeView === "customers" && <Customers />}
        {activeView === "schedule" && <Schedule crewId={effectiveCrewId} />}
        {activeView === "pipeline" && <Pipeline />}
        {activeView === "phc" && <Phc />}
        {activeView === "estimates" && <Estimates />}
        {activeView === "invoices" && <Invoices />}
        {activeView === "timesheets" && <Timesheets crewId={effectiveCrewId} />}
        {activeView === "automations" && <Automations />}
        {activeView === "activity" && <Activity />}
        {activeView === "messages" && <Messages />}
        {activeView === "crew" && <CrewView />}
        {activeView === "guide" && <FieldGuide />}
        {activeView === "sales" && <SalesCalendar />}
        {activeView === "equipment" && <EquipmentPage />}
        {activeView === "portal" && <CustomerPortal />}
        {activeView === "users" && <Users />}
        {activeView === "crew-rules" && <CrewRules />}
        {activeView === "documents" && <LicencesInsurance />}
        {activeView === "me" && (
          <MePage
            crewId={effectiveCrewId}
            onTwoStep={() => setShowTwoStep(true)}
          />
        )}
      </main>

      <UrlSync activeView={activeView} allowed={allowedIds} onView={openView} />
      <DetailDrawers />
      <InvoiceComposer />
      <FlashBar />
      <AskAI />
      {tourOpen && <Tour onClose={() => setTourOpen(false)} />}

      {!supabaseMode && (
      <footer className="mx-auto max-w-7xl px-4 pb-8">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          <p>
            Prototype only — no real authentication, no shared database,
            no payments. Data lives in this browser only.
          </p>
          {isOwnerLike(role) && (
            <button
              onClick={() => {
                if (
                  window.confirm(
                    "Reset everything? This erases all preview data in this browser and starts over empty (the setup wizard will appear again).",
                  )
                ) {
                  resetDemo();
                }
              }}
              className="font-semibold text-red-700 hover:underline"
            >
              Reset preview data
            </button>
          )}
        </div>
      </footer>
      )}
    </div>
  );
}

export default function App() {
  // The customer's private accept page (/accept/<token>, from the
  // estimate email) is public too, and shows only that one estimate.
  if (
    typeof window !== "undefined" &&
    window.location.pathname.startsWith("/accept/")
  ) {
    return (
      <AcceptEstimate token={acceptTokenFromPath(window.location.pathname)} />
    );
  }
  // The public booking page lives outside the login gate: anyone with
  // the link can request an estimate visit, no account needed.
  if (
    typeof window !== "undefined" &&
    window.location.hash.startsWith("#/book")
  ) {
    return <BookEstimate />;
  }
  // A crew's printable run sheet lives outside the app shell (no
  // header/nav, so the printed page is clean) but inside the
  // provider, so it reads the same live state and permissions.
  if (
    typeof window !== "undefined" &&
    window.location.hash.startsWith("#/runsheet/")
  ) {
    return (
      <AppProvider>
        <RunSheet />
      </AppProvider>
    );
  }
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
