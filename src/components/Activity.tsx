import { useMemo, useState } from "react";
import { useLoadedState, useStore } from "../store";
import {
  filterActivityForViewer,
  visibleActivityJobs,
} from "../activityVisibility";
import AuditList from "./AuditLog";
import { actorIsMember, auditLine } from "../auditText";
import { inputCls, labelCls } from "./ui";

/**
 * Global activity page: every audit entry in the system, filterable by
 * job, employee, and customer, plus a text search. Entries stay
 * clickable into their records through the drawer system (see
 * AuditList). Each job also carries its own activity section inside
 * the job drawer — this page is the all-jobs view of the same log.
 *
 * Crew viewers see a scoped feed only (see activityVisibility.ts):
 * changes to a job they are assigned to, or changes to a week in
 * which they have at least one scheduled day. Owners and office see
 * everything. The Job/Customer filter dropdowns are scoped the same
 * way so they do not list records the viewer cannot see entries for.
 */
export default function Activity() {
  const { state } = useStore();
  if (!state) return null;
  return <ActivityLoaded />;
}

function ActivityLoaded() {
  const { role, viewerId } = useStore();
  const state = useLoadedState();
  const [jobFilter, setJobFilter] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [query, setQuery] = useState("");


  const isCrew = role === "crew";
  const visibleJobs = useMemo(
    () => visibleActivityJobs(state, viewerId, isCrew),
    [state, viewerId, isCrew],
  );
  const visibleCustomers = useMemo(() => {
    if (!isCrew) return state.customers;
    const customerIds = new Set(visibleJobs.map((j) => j.customerId));
    return state.customers.filter((c) => customerIds.has(c.id));
  }, [state, visibleJobs, isCrew]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inScope = filterActivityForViewer(
      state,
      state.auditLog,
      viewerId,
      isCrew,
    );
    return inScope.filter((e) => {
      if (jobFilter) {
        const onJob =
          e.jobId === jobFilter ||
          (e.entity === "Job" && e.entityId === jobFilter);
        if (!onJob) return false;
      }
      if (employeeFilter) {
        const member = state.crew.find((c) => c.id === employeeFilter);
        const byActor = member ? actorIsMember(e.actor, member) : false;
        const byUserEntity =
          e.entity === "User" && e.entityId === employeeFilter;
        const byTimesheet =
          e.entity === "Timesheet" &&
          state.timesheets.some(
            (t) => t.id === e.entityId && t.crewId === employeeFilter,
          );
        if (!byActor && !byUserEntity && !byTimesheet) return false;
      }
      if (customerFilter && e.customerId !== customerFilter) return false;
      if (q) {
        const hay =
          `${auditLine(e, { equipment: (id) => state.equipment.find((q) => q.id === id)?.name })} ${e.entity} ${e.field} ${e.oldValue} ${e.newValue}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [state, jobFilter, employeeFilter, customerFilter, query, viewerId, isCrew]);

  const jobName = (id: string) =>
    state.jobs.find((j) => j.id === id)?.title ?? "Job";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Activity</h1>
        <p className="mt-1 text-sm text-slate-600">
          {isCrew
            ? "Changes to your jobs and the weeks you work — other jobs and weeks are hidden. Click a record name to open it; jobs you're not assigned to aren't clickable. Each job also has its own activity section inside the job drawer."
            : "Every change in the system, with who made it and when — even a quantity changed from 1 to 2. Click any record name to open it. Each job also has its own activity section inside the job drawer."}
        </p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className={labelCls()}>Job</label>
            <select
              className={inputCls()}
              value={jobFilter}
              onChange={(e) => setJobFilter(e.target.value)}
            >
              <option value="">All jobs</option>
              {visibleJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls()}>Employee</label>
            <select
              className={inputCls()}
              value={employeeFilter}
              onChange={(e) => setEmployeeFilter(e.target.value)}
            >
              <option value="">All employees</option>
              {state.crew.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.role}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls()}>Customer</label>
            <select
              className={inputCls()}
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
            >
              <option value="">All customers</option>
              {visibleCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls()}>Search</label>
            <input
              className={inputCls()}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Who, what, or which change…"
            />
          </div>
        </div>
        {(jobFilter || employeeFilter || customerFilter || query) && (
          <button
            onClick={() => {
              setJobFilter("");
              setEmployeeFilter("");
              setCustomerFilter("");
              setQuery("");
            }}
            className="mt-3 text-sm font-semibold text-emerald-700 hover:underline"
          >
            Clear filters
          </button>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="mb-3 text-sm text-slate-500">
          {filtered.length} entr{filtered.length === 1 ? "y" : "ies"}
          {jobFilter ? ` for ${jobName(jobFilter)}` : ""}
        </p>
        <AuditList
          entries={filtered}
          emptyText="No activity matches these filters yet. Every change made anywhere in the app will appear here."
        />
      </section>
    </div>
  );
}
