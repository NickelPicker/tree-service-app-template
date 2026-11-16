import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { View } from "../store";
import { askAI, type AskAnswer } from "../askai";
import { companyName } from "../company";
import { primaryBtn } from "./ui";

interface ChatMsg {
  role: "user" | "ai";
  text: string;
  kind?: "answer" | "draft";
  customerId?: string | null;
  jobId?: string | null;
  view?: View | null;
  viewLabel?: string | null;
}

const SUGGESTIONS = [
  "What's on tomorrow?",
  "How much are we making this week?",
  "Who owes us money?",
  "Draft a text to a customer",
  "How do I add a job?",
  "What estimates are still waiting?",
];

function toMsg(a: AskAnswer): ChatMsg {
  return {
    role: "ai",
    text: a.text,
    kind: a.kind,
    customerId: a.customerId ?? null,
    jobId: a.jobId ?? null,
    view: a.view ?? null,
    viewLabel: a.viewLabel ?? null,
  };
}

/**
 * Ask AI — floating helper on every page. Answers from the company's live
 * data in the app (schedule, customers, jobs, estimates, invoices) and
 * walks the team through how to do things. It is a built-in assistant,
 * not a live AI connection: the app has no server to call an LLM from.
 */
export default function AskAI() {
  const { state, viewerName, openCustomer, openJob, setView } =
    useStore();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const showMoney = useStore().showMoney;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  if (!state) return null;

  const send = (text: string) => {
    const q = text.trim();
    if (!q) return;
    const answer = askAI(state, q, showMoney, viewerName || companyName(state));
    setMessages((m) => [...m, { role: "user", text: q }, toMsg(answer)]);
    setInput("");
  };

  const copyDraft = async (idx: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIdx(idx);
      window.setTimeout(() => setCopiedIdx(null), 2000);
    } catch {
      // Clipboard unavailable (older browsers) — the text is still visible to copy by hand.
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        // On a phone it sits at the end of the page, never floating over
        // the crew's buttons; on a computer it floats in the corner.
        className="z-50 mx-auto mb-4 block min-h-11 rounded-full bg-emerald-700 px-4 py-3 text-sm font-bold text-white shadow-lg hover:bg-emerald-800 sm:fixed sm:bottom-5 sm:right-5 sm:mb-0"
      >
        {open ? "Close Ask AI ✕" : "✦ Ask AI"}
      </button>

      {open && (
        <section className="fixed bottom-20 right-4 z-50 flex h-[min(70vh,560px)] w-[min(92vw,380px)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="border-b border-slate-200 bg-emerald-700 px-4 py-3 text-white">
            <p className="font-bold">Ask AI</p>
            <p className="text-xs text-emerald-100">
              Answers from your live data — schedule, customers, jobs, money.
            </p>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 && (
              <div>
                <p className="text-sm text-slate-600">
                  Hi — ask me about the schedule, a customer, money, or how
                  to do something in the app. A few ideas:
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => send(s)}
                      className="rounded-full border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "ml-auto bg-emerald-700 text-white"
                    : "bg-slate-100 text-slate-900"
                }`}
              >
                <p>{m.text}</p>
                {m.role === "ai" && m.kind === "draft" && (
                  <button
                    onClick={() => copyDraft(i, m.text)}
                    className="mt-2 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:border-emerald-500"
                  >
                    {copiedIdx === i ? "Copied ✓" : "Copy draft"}
                  </button>
                )}
                {m.role === "ai" && (m.customerId || m.jobId || m.view) && (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {m.customerId && (
                      <button
                        onClick={() => openCustomer(m.customerId as string)}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-emerald-700 hover:border-emerald-500"
                      >
                        Open customer
                      </button>
                    )}
                    {m.jobId && (
                      <button
                        onClick={() => openJob(m.jobId as string)}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-emerald-700 hover:border-emerald-500"
                      >
                        Open job
                      </button>
                    )}
                    {m.view && (
                      <button
                        onClick={() => setView(m.view as View)}
                        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-emerald-700 hover:border-emerald-500"
                      >
                        {m.viewLabel ?? "Open"}
                      </button>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>

          <form
            className="flex gap-2 border-t border-slate-200 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="Ask about the schedule, a customer, money…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button type="submit" className={primaryBtn()}>
              Send
            </button>
          </form>
          <p className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
            Built-in helper — it answers from this app&apos;s data, not a live
            AI chat. Money totals stay hidden for crew accounts.
          </p>
        </section>
      )}
    </>
  );
}
