import { useMemo, useState } from "react";
import { customerMatches } from "../customerSearch";
import { useStore } from "../store";
import { latestMessage } from "../messages";
import { smsNumber } from "../company";
import { fmtDateTime } from "../utils";
import MessageThread from "./MessageThread";
import { inputCls } from "./ui";

/**
 * Global Messages page: every customer thread in one place, most
 * recent first. Click a customer to open their full shared thread —
 * the same thread shown on their customer profile. Sending follows
 * the per-person switch "Can message customers" on the Team page.
 * Everyone can read threads.
 */
export default function Messages() {
  const { state, openCustomer } = useStore();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const threads = useMemo(() => {
    if (!state) return [];
    const q = query.trim().toLowerCase();
    return state.customers
      .map((c) => ({ customer: c, latest: latestMessage(state.messages ?? [], c.id) }))
      .filter(({ customer, latest }) => {
        if (!latest) return false;
        if (!q) return true;
        return (
          customerMatches(customer, q) ||
          `${latest.senderName} ${latest.body}`.toLowerCase().includes(q)
        );
      })
      .sort((a, b) =>
        (b.latest?.createdAt ?? "").localeCompare(a.latest?.createdAt ?? ""),
      );
  }, [state, query]);

  if (!state) return null;
  const selected =
    state.customers.find((c) => c.id === selectedId) ??
    threads[0]?.customer ??
    null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Messages</h1>
        <p className="mt-1 text-sm text-slate-600">
          One shared thread per customer, visible to the whole team.
          Texts go out from {smsNumber(state) || "your business number"} only — personal phone
          numbers are never shown to the customer. Tap a thread to
          read it.
        </p>
      </div>

      <input
        className={inputCls()}
        placeholder="Search threads by customer, sender, or message…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {threads.length === 0 ? (
        <p className="text-sm text-slate-500">
          No messages yet. Open a customer and start a thread from their
          profile.
        </p>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <ul className="min-w-0 space-y-2">
            {threads.map(({ customer, latest }) => (
              <li key={customer.id}>
                <button
                  onClick={() => setSelectedId(customer.id)}
                  className={`w-full rounded-xl border bg-white p-3 text-left shadow-sm hover:border-emerald-500 ${
                    selected?.id === customer.id
                      ? "border-emerald-600"
                      : "border-slate-200"
                  }`}
                >
                  <p className="flex min-w-0 items-center justify-between gap-2 font-semibold text-slate-900">
                    <span className="min-w-0 truncate">
                      {customer.firstName} {customer.lastName}
                    </span>
                    <span className="text-xs font-normal text-slate-500">
                      {latest ? fmtDateTime(latest.createdAt) : ""}
                    </span>
                  </p>
                  <p className="truncate text-sm text-slate-600">
                    {latest?.direction === "out"
                      ? `${latest.senderName}: `
                      : `${customer.firstName}: `}
                    {latest?.body}
                  </p>
                  <p className="text-xs text-slate-500">
                    {latest?.channel === "sms"
                      ? `SMS · via ${smsNumber(state) || "your business number"}`
                      : latest?.channel === "email"
                        ? "Email"
                        : "Call log"}
                    {latest?.queued ? " · Queued" : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <section className="h-fit min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 break-words">
                  <h2 className="text-lg font-bold text-slate-900">
                    {selected.firstName} {selected.lastName}
                  </h2>
                  <p className="text-sm text-slate-600">
                    {selected.phone}
                    {selected.email ? ` · ${selected.email}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => openCustomer(selected.id)}
                  className="text-sm font-semibold text-emerald-700 hover:underline"
                >
                  Open customer
                </button>
              </div>
              <MessageThread key={selected.id} customerId={selected.id} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
