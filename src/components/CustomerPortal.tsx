import { useState } from "react";
import { useStore } from "../store";
import { fmtDate, isBlankCustomer, money, todayStr } from "../utils";
import { docTotals, StatusBadge } from "./ui";
import HowToPay from "./HowToPay";

/**
 * Customer portal ("View as customer"): what a customer sees — their
 * proposals with option selection and a simulated accept (typed name +
 * date, clearly preview-only — no real signature capture or payment),
 * their invoices with a preview-only pay action, and their jobs and
 * PHC programs. Read-only for the customer except accepting a
 * proposal, which is the one action the portal exists for.
 */
export default function CustomerPortal() {
  const { state, acceptProposal, openJob } = useStore();
  const [customerId, setCustomerId] = useState(
    () => state?.customers.find((c) => !isBlankCustomer(c))?.id ?? "",
  );
  const [selectedOption, setSelectedOption] = useState<Record<string, string>>(
    {},
  );
  const [signName, setSignName] = useState<Record<string, string>>({});
  const [acceptedJob, setAcceptedJob] = useState<Record<string, string>>({});
  const [paidNotice, setPaidNotice] = useState<Record<string, boolean>>({});

  if (!state) return null;
  const customer = state.customers.find((c) => c.id === customerId) ?? null;
  const estimates = state.estimates.filter((e) => e.customerId === customerId);
  const invoices = state.invoices.filter((i) => i.customerId === customerId);
  const jobs = state.jobs.filter((j) => j.customerId === customerId);
  const programs = state.phcPrograms.filter((p) => p.customerId === customerId);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h1 className="text-xl font-bold text-slate-900">
          Customer portal — preview
        </h1>
        <p className="mt-1 text-sm text-amber-900">
          This shows what the customer would see, with their real
          estimates, invoices and jobs. Nothing here takes a real
          payment: the pay button is only pretend.
        </p>
        <label className="mt-3 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          View as customer
        </label>
        <select
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          {state.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.firstName} {c.lastName}
              {c.type === "commercial" ? ` — ${c.companyName ?? c.company}` : ""}
            </option>
          ))}
        </select>
      </div>

      {customer && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-bold text-slate-900">
            {customer.firstName} {customer.lastName}
          </h2>
          <p className="text-sm text-slate-600">
            {[customer.address, [customer.city, customer.zip].filter(Boolean).join(" ")]
              .filter((x) => x && x.trim())
              .join(", ")}
          </p>
          {customer.type === "commercial" && (
            <p className="mt-1 text-sm text-sky-900">
              {customer.companyName}
              {customer.projectName ? ` · ${customer.projectName}` : ""}
              {customer.projectNumber ? ` (${customer.projectNumber})` : ""}
              {customer.poNumber ? ` · PO ${customer.poNumber}` : ""}
            </p>
          )}
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">
          Your proposals
        </h2>
        {estimates.length === 0 ? (
          <p className="text-sm text-slate-500">No proposals yet.</p>
        ) : (
          <div className="space-y-4">
            {estimates.map((e) => {
              const options = e.options ?? [];
              const accepted = e.acceptedOptionId
                ? options.find((o) => o.id === e.acceptedOptionId)
                : null;
              return (
                <div
                  key={e.id}
                  className="rounded-lg border border-slate-200 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900">{e.title}</p>
                    <StatusBadge status={e.status} />
                  </div>
                  {accepted ? (
                    <p className="mt-1 text-sm text-emerald-800">
                      You accepted the {accepted.label} option
                      {e.acceptedBy ? ` — signed ${e.acceptedBy}` : ""}
                      {e.acceptedAt
                        ? ` on ${new Date(e.acceptedAt).toLocaleDateString()}`
                        : ""}
                      . Thank you!
                    </p>
                  ) : options.length > 0 ? (
                    <div className="mt-2 space-y-2">
                      {options.map((o) => {
                        const ot = docTotals(
                          o.lines,
                          e.taxRate,
                          e.discountType ?? "none",
                          e.discountValue ?? 0,
                        );
                        const picked = selectedOption[e.id] === o.id;
                        return (
                          <label
                            key={o.id}
                            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 ${
                              picked
                                ? "border-emerald-600 bg-emerald-50"
                                : "border-slate-200"
                            }`}
                          >
                            <input
                              type="radio"
                              name={`opt-${e.id}`}
                              checked={picked}
                              onChange={() =>
                                setSelectedOption((p) => ({
                                  ...p,
                                  [e.id]: o.id,
                                }))
                              }
                              className="mt-1 accent-emerald-700"
                            />
                            <span className="text-sm">
                              <span className="font-bold text-slate-900">
                                {o.label} — {money(ot.total)}
                              </span>
                              <span className="block text-slate-600">
                                {o.description}
                              </span>
                              <span className="block text-xs text-slate-500">
                                {o.lines
                                  .map((l) => l.description)
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      <div className="flex flex-wrap gap-2">
                        <input
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:w-auto"
                          value={signName[e.id] ?? ""}
                          onChange={(ev) =>
                            setSignName((p) => ({
                              ...p,
                              [e.id]: ev.target.value,
                            }))
                          }
                          placeholder="Type your full name to sign"
                        />
                        <button
                          onClick={() => {
                            const optId = selectedOption[e.id];
                            const name = (signName[e.id] ?? "").trim();
                            if (!optId || !name) return;
                            const jobId = acceptProposal(e.id, optId, name);
                            if (jobId) {
                              setAcceptedJob((p) => ({ ...p, [e.id]: jobId }));
                            }
                          }}
                          disabled={
                            !selectedOption[e.id] ||
                            !(signName[e.id] ?? "").trim()
                          }
                          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                        >
                          Accept & sign (preview e-sign)
                        </button>
                      </div>
                      <p className="text-xs text-slate-500">
                        Preview only — typing your name stands in for a
                        signature. No real signature is captured and no
                        payment is taken here.
                      </p>
                      {acceptedJob[e.id] && (
                        <p className="text-sm text-emerald-800">
                          Accepted — your job is scheduled.{" "}
                          <button
                            onClick={() => openJob(acceptedJob[e.id])}
                            className="font-semibold underline"
                          >
                            View it in the office app →
                          </button>
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2">
                      <p className="text-sm text-slate-700">
                        Total:{" "}
                        <span className="font-bold">
                          {money(
                            docTotals(
                              e.lines,
                              e.taxRate,
                              e.discountType ?? "none",
                              e.discountValue ?? 0,
                            ).total,
                          )}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500">
                        Reply to your estimate email to accept, or call the
                        office.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">
          Your invoices
        </h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-slate-500">No invoices yet.</p>
        ) : (
          <ul className="space-y-3">
            {invoices.map((i) => {
              const total = docTotals(
                i.lines,
                i.taxRate,
                i.discountType ?? "none",
                i.discountValue ?? 0,
              ).total;
              return (
                <li
                  key={i.id}
                  className="rounded-lg border border-slate-200 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900">
                      {i.number} · {money(total)}
                    </p>
                    <StatusBadge status={i.status} />
                  </div>
                  <p className="text-sm text-slate-500">
                    Due {fmtDate(i.dueDate)}
                    {(i.splits ?? []).length > 0
                      ? ` · split between ${(i.splits ?? []).length} recipients`
                      : ""}
                  </p>
                  {i.status !== "paid" && (
                    <div className="mt-2">
                      <button
                        onClick={() =>
                          setPaidNotice((p) => ({ ...p, [i.id]: true }))
                        }
                        className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                      >
                        Pay {money(total)} (preview)
                      </button>
                      {paidNotice[i.id] && (
                        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                          Preview only — no payment was processed and no
                          card was charged. In the live app this connects
                          to the payment processor; the office records the
                          payment once it clears.
                        </p>
                      )}
                      <HowToPay invoiceNumber={i.number} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-900">Your jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500">No jobs scheduled.</p>
        ) : (
          <ul className="space-y-2">
            {jobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-slate-800">
                  {j.title} · {fmtDate(j.date)} {j.startTime}
                </span>
                <StatusBadge status={j.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {programs.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-base font-bold text-slate-900">
            Your plant health care programs
          </h2>
          <ul className="space-y-2">
            {programs.map((p) => (
              <li key={p.id} className="text-sm text-slate-800">
                <span className="font-semibold">{p.name}</span> · {p.type} ·{" "}
                renews {p.renewalDate ? fmtDate(p.renewalDate) : "—"}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-slate-500">
        Portal date: {todayStr()}. Preview of what this customer sees,
        using their real estimates, invoices and jobs. Customers cannot
        log in to it yet, and payments here are only pretend.
      </p>
    </div>
  );
}
