import { useState } from "react";
import { useStore } from "../store";
import type { View } from "../store";
import { primaryBtn, secondaryBtn } from "./ui";

/**
 * Guided tour entry point — the first step toward the orientation
 * video. A short overlay that walks the new areas in
 * order, one line each, jumping to each page as it goes. Dismissible
 * at any step.
 */

const STEPS: Array<{
  title: string;
  text: string;
  view: View | null;
}> = [
  {
    title: "1 · Dashboard",
    text: "Today at a glance, plus two new widgets: the sales pipeline and PHC renewals coming due.",
    view: "dashboard",
  },
  {
    title: "2 · Sales pipeline",
    text: "Every job's journey — Lead, Estimate, Proposal, Job, Invoice, Paid — with cards that open the record.",
    view: "pipeline",
  },
  {
    title: "3 · Plant Health Care",
    text: "Recurring programs like EAB treatment and fertilization, with visit schedules, chemical records, and renewal dates.",
    view: "phc",
  },
  {
    title: "4 · Multi-option proposals",
    text: "Estimates can offer Good / Better / Best. The customer picks one and signs with a typed name — that creates the job.",
    view: "estimates",
  },
  {
    title: "5 · Customers & tree map",
    text: "Each tree carries its work history, DBH and condition history, and a risk rating. The public-record button imports Denver's inventory trees for a property.",
    view: "customers",
  },
  {
    title: "6 · Schedule, equipment & route",
    text: "Jobs take crew and equipment. The route view lists the day's jobs in order, and a dropped pin locates a job with no street address.",
    view: "schedule",
  },
  {
    title: "7 · Split invoicing",
    text: "One invoice can bill several people at once — by percentage or fixed amount — with payment tracked per recipient.",
    view: "invoices",
  },
  {
    title: "8 · Customer portal",
    text: "See what the customer sees: their proposals, invoices, and a preview-only pay button. No real payment is processed.",
    view: "portal",
  },
  {
    title: "9 · Crew view",
    text: "The phone-first day sheet: today's jobs, a checklist per job, clock in/out, and a Navigate button for pinned jobs.",
    view: "crew",
  },
];

export default function Tour({
  onClose,
}: {
  onClose: () => void;
}) {
  const { setView } = useStore();
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const go = (i: number) => {
    setStep(i);
    const v = STEPS[i].view;
    if (v) setView(v);
  };
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-emerald-200 bg-white p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
              Guided tour
            </p>
            <p className="mt-1 text-base font-bold text-slate-900">
              {current.title}
            </p>
            <p className="mt-1 text-sm text-slate-700">{current.text}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg text-lg text-slate-400 hover:text-slate-700"
            title="Close tour"
          >
            ✕
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            Step {step + 1} of {STEPS.length}
          </p>
          <div className="flex gap-2">
            {step > 0 && (
              <button onClick={() => go(step - 1)} className={secondaryBtn()}>
                ← Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button onClick={() => go(step + 1)} className={primaryBtn()}>
                Next →
              </button>
            ) : (
              <button onClick={onClose} className={primaryBtn()}>
                Finish tour
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
