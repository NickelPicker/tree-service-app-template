/**
 * Ask AI — the built-in assistant inside the app.
 *
 * This is NOT a live connection to an AI model: the app is a static site with no
 * server, so there is no LLM API to call. Instead Ask AI answers from the
 * company's live data already in the app (customers, jobs, schedule,
 * estimates, invoices) plus built-in how-to answers for the app itself.
 * If the team later wants a true LLM behind this panel, the path is an
 * API key plus a small serverless function — see README.
 */
import { companyName, smsNumber } from "./company";
import { estimateTotals } from "./email";
import { jobValue } from "./jobValue";
import { invoiceTotal } from "./splits";
import type { View } from "./store";
import type { AppState, Customer, Job } from "./types";
import {
  addDaysISO,
  fmtDate,
  isBlankCustomer,
  money,
  mondayOf,
  todayStr,
} from "./utils";
import { estimateStatusLabel } from "./estimateStatus";

export interface AskAnswer {
  text: string;
  kind: "answer" | "draft";
  customerId?: string | null;
  jobId?: string | null;
  view?: View | null;
  viewLabel?: string | null;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "on", "in", "at", "is", "are", "was",
  "do", "does", "did", "i", "we", "you", "me", "my", "our", "us", "it", "its",
  "and", "or", "with", "about", "please", "can", "could", "would", "should",
  "what", "whats", "what's", "who", "who's", "how", "when", "where", "show",
  "find", "get", "give", "tell", "list", "all", "any", "there", "here",
  "job", "jobs", "customer", "customers", "estimate", "estimates",
  "invoice", "invoices", "day", "week", "month", "today", "tomorrow",
  "draft", "write", "text", "message", "send", "saying", "say", "let",
  "know", "them", "him", "her", "his", "their", "this", "that", "have",
  "has", "had", "be", "been", "by", "from", "up", "out", "over",
]);

function words(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function contentWords(q: string): string[] {
  return words(q).filter((w) => !STOPWORDS.has(w) && w.length >= 2);
}

/** Next date (starting today) with the given weekday name. */
function nextWeekday(fromIso: string, weekday: string): string | null {
  const target = WEEKDAYS.indexOf(weekday);
  if (target < 0) return null;
  const d = new Date(
    parseInt(fromIso.slice(0, 4), 10),
    parseInt(fromIso.slice(5, 7), 10) - 1,
    parseInt(fromIso.slice(8, 10), 10),
  );
  for (let i = 0; i < 7; i++) {
    if (d.getDay() === target) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    d.setDate(d.getDate() + 1);
  }
  return null;
}

export function fmtDay(iso: string): string {
  const d = new Date(
    parseInt(iso.slice(0, 4), 10),
    parseInt(iso.slice(5, 7), 10) - 1,
    parseInt(iso.slice(8, 10), 10),
  );
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function dayJobs(state: AppState, date: string): Job[] {
  return state.jobs
    .filter((j) => j.date === date)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

function dayTotal(state: AppState, date: string): number {
  return dayJobs(state, date).reduce(
    (s, j) => s + (jobValue(state, j) ?? 0),
    0,
  );
}

function customerName(c: Customer): string {
  const name = `${c.firstName} ${c.lastName}`.trim();
  return name || c.company || "Unnamed customer";
}

function jobLine(state: AppState, j: Job, showMoney: boolean): string {
  const cust = state.customers.find((c) => c.id === j.customerId);
  const crew = state.crew
    .filter((c) => j.crewIds.includes(c.id))
    .map((c) => c.name)
    .join(", ");
  const v = jobValue(state, j);
  return (
    `${j.startTime} · ${j.title}` +
    (cust ? ` — ${customerName(cust)}` : "") +
    (crew ? ` · ${crew}` : " · Unassigned") +
    (v !== null && showMoney ? ` · ${money(v)}` : "")
  );
}

/** Rank non-blank customers by how many of the question's content words match them. */
function findCustomers(state: AppState, q: string): Customer[] {
  const toks = contentWords(q);
  if (toks.length === 0) return [];
  const scored = state.customers
    .filter((c) => !isBlankCustomer(c))
    .map((c) => {
      const hay =
        `${c.firstName} ${c.lastName} ${c.company} ${c.companyName ?? ""} ${c.address} ${c.city} ${c.phone} ${c.email}`.toLowerCase();
      const score = toks.filter((t) => hay.includes(t)).length;
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.c);
}

function dayAnswer(
  state: AppState,
  date: string,
  showMoney: boolean,
): AskAnswer {
  const jobs = dayJobs(state, date);
  const total = dayTotal(state, date);
  const label = fmtDay(date);
  if (jobs.length === 0) {
    return {
      text: `${label} — no jobs scheduled.\n\nNothing on the books that day.`,
      kind: "answer",
      view: "schedule",
      viewLabel: "Open Schedule",
    };
  }
  const lines = jobs.map((j) => `• ${jobLine(state, j, showMoney)}`).join("\n");
  return {
    text:
      `${label} — ${jobs.length} job${jobs.length === 1 ? "" : "s"}` +
      (showMoney ? ` · ${money(total)} total` : "") +
      `\n${lines}`,
    kind: "answer",
    view: "schedule",
    viewLabel: "Open Schedule",
  };
}

function weekAnswer(
  state: AppState,
  mondayIso: string,
  label: string,
  showMoney: boolean,
): AskAnswer {
  const days: string[] = [];
  let total = 0;
  let count = 0;
  for (let i = 0; i < 7; i++) {
    const date = addDaysISO(mondayIso, i);
    const jobs = dayJobs(state, date);
    if (jobs.length === 0) continue;
    count += jobs.length;
    total += dayTotal(state, date);
    days.push(
      `${fmtDay(date)} — ${jobs.length} job${jobs.length === 1 ? "" : "s"}` +
        (showMoney ? ` · ${money(dayTotal(state, date))}` : "") +
        "\n" +
        jobs.map((j) => `  • ${jobLine(state, j, showMoney)}`).join("\n"),
    );
  }
  if (count === 0) {
    return {
      text: `${label} — nothing scheduled that week.`,
      kind: "answer",
      view: "schedule",
      viewLabel: "Open Schedule",
    };
  }
  return {
    text:
      `${label} — ${count} job${count === 1 ? "" : "s"}` +
      (showMoney ? ` · ${money(total)} total` : "") +
      `\n\n${days.join("\n\n")}`,
    kind: "answer",
    view: "schedule",
    viewLabel: "Open Schedule",
  };
}

const HOW_TO: Array<{ match: RegExp; text: string }> = [
  {
    match: /add (a )?job|create (a )?job|new job|schedule (a )?job/,
    text: "To add a job:\n1. Go to Schedule.\n2. Tap + New job (or + New job this day under the day you want).\n3. Search for the customer by name, pick them, and set the date, start time, and service type.\n4. For the location, the job uses the customer's address unless you drop a pin on the map at the bottom of the job form.\n5. Save — the job appears on the calendar and in the customer's job history.",
  },
  {
    match: /estimate|proposal|quote/,
    text: "To create an estimate:\n1. Go to Estimates → + New estimate.\n2. Search for the customer, add line items (description, quantity, price), and set any discount.\n3. Send it from the estimate page — it goes out as the full estimate in the email body, so it's searchable in Gmail.\n4. For a Good / Better / Best proposal, turn on multi-option proposals in the estimate form. When the customer accepts an option, a job is created from it automatically.",
  },
  {
    match: /invoice|bill|charge|payment/,
    text: "To invoice a customer:\n1. Go to Invoices → + New invoice, or create one from a job or an estimate.\n2. Check the lines, discount, and tax, then Send, Preview, or Save for later.\n3. To split a bill between two payers (for commercial work), use split invoicing on the invoice — each recipient gets their own share and payment status.",
  },
  {
    match: /customer|add (a )?client/,
    text: "To add a customer:\n1. Go to Customers → + New customer.\n2. Fill in their name, phone, email, and address — the address is what the job location and routing use.\n3. Tap a customer in the list to expand them: jobs, estimates, invoices, messages, activity, and their tree map are all right there.",
  },
  {
    match: /tree|trees|map|pin/,
    text: "To map a customer's trees:\n1. Open the customer (Customers → tap their name to expand, then Tree map & inventory).\n2. Tap Locate property to center the map on their address, then click on the map to drop a tree dot.\n3. Fill in the species, DBH, height, and condition — the tree shows up in the inventory list and on future job and estimate lines.",
  },
  {
    match: /clock in|clock out|timesheet|hours/,
    text: "To track hours:\n1. Go to Timesheets — each crew member clocks in when they arrive at a job and out when they leave.\n2. Timesheets are editable, and the app records where the entry was made.\n3. Admins can review and edit everyone's hours from the Timesheets page.",
  },
  {
    match: /message|text (a )?customer|contact/,
    text: "To message a customer:\n1. Open the customer and scroll to Communications — every message with that customer lives in one shared thread.\n2. Type and send. It goes out from the business number {smsNumber}, and the whole team sees it.\n3. Each person has their own intro line — set yours on your own crew profile.",
  },
  {
    match: /route|driving|directions|navigate/,
    text: "To see a day's route:\n1. Go to Schedule and click the day.\n2. Switch the day view from Jobs to Route — it lists the stops in order with driving distance and time per leg, plus a Google Maps link for the whole route.\n3. Hovering a day on the calendar (when route preview is on in Calendar settings) shows the same route map on the left.",
  },
];

const CAPABILITIES = `I answer from your live data in this app — schedule, customers, jobs, estimates, invoices, and money. Try one of these:

• "What's on tomorrow?"
• "How much are we making this week?"
• "Who owes us money?"
• "Find a customer"
• "Draft a text to a customer"
• "How do I add a job?"`;

export function askAI(
  state: AppState,
  question: string,
  showMoney: boolean,
  senderName: string,
): AskAnswer {
  const q = question.trim();
  const lower = q.toLowerCase();
  const today = todayStr();

  if (!q) {
    return { text: CAPABILITIES, kind: "answer" };
  }
  if (/^(hi|hello|hey|good morning|good afternoon)\b/.test(lower) || lower.includes("what can you do") || lower === "help") {
    return { text: `Hi — I'm Ask AI, the helper inside this app.\n\n${CAPABILITIES}`, kind: "answer" };
  }

  // --- Draft a message to a customer ---
  if (/\b(draft|write|compose)\b/.test(lower) && /\b(text|message|email|note)\b/.test(lower)) {
    const matches = findCustomers(state, q);
    if (matches.length === 0) {
      return {
        text: "I couldn't find that customer — check the spelling, or add them from Customers → + New customer, then ask me again.",
        kind: "answer",
        view: "customers",
        viewLabel: "Open Customers",
      };
    }
    const c = matches[0];
    // Topic = the question minus the draft words and the customer's name words.
    const nameWords = new Set(
      `${c.firstName} ${c.lastName} ${c.company}`.toLowerCase().split(/\s+/),
    );
    const topic = words(q)
      .filter((w) => !STOPWORDS.has(w) && !nameWords.has(w))
      .join(" ");
    const upcoming = state.jobs
      .filter((j) => j.customerId === c.id && j.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))[0];
    let body: string;
    if (topic) {
      const sentence = topic.charAt(0).toUpperCase() + topic.slice(1);
      body = sentence.endsWith(".") || sentence.endsWith("!") || sentence.endsWith("?") ? sentence : `${sentence}.`;
    } else if (upcoming) {
      body = `Just confirming your ${upcoming.title} scheduled for ${fmtDay(upcoming.date)} at ${upcoming.startTime}. Let us know if anything changes.`;
    } else {
      body = "Just checking in — let us know if you'd like to get any tree work scheduled.";
    }
    const draft = `Hi ${c.firstName}, this is ${senderName} with ${companyName(state)}: ${body}`;
    return {
      text: draft,
      kind: "draft",
      customerId: c.id,
      view: "messages",
      viewLabel: "Open Messages",
    };
  }

  // --- Best / lightest day ---
  if (/best day|suggest( a)? day|when should|lightest|least busy|emptiest/.test(lower)) {
    const rows: Array<{ date: string; count: number; total: number }> = [];
    for (let i = 0; i < 7; i++) {
      const date = addDaysISO(today, i);
      rows.push({ date, count: dayJobs(state, date).length, total: dayTotal(state, date) });
    }
    rows.sort((a, b) => a.count - b.count || a.total - b.total);
    const best = rows[0];
    const lines = rows
      .map(
        (r) =>
          `${fmtDay(r.date)} — ${r.count} job${r.count === 1 ? "" : "s"}` +
          (showMoney ? ` · ${money(r.total)}` : ""),
      )
      .join("\n");
    return {
      text:
        `Lightest day in the next week is ${fmtDay(best.date)} (${best.count} job${best.count === 1 ? "" : "s"}).` +
        `\n\n${lines}\n\nFull day suggestions — balancing the daily target and driving distance — are coming with Calendar settings.`,
      kind: "answer",
      view: "schedule",
      viewLabel: "Open Schedule",
    };
  }

  // --- Schedule: a specific day or week ---
  if (
    /\btoday\b/.test(lower) ||
    /\btomorrow\b/.test(lower) ||
    WEEKDAYS.some((d) => lower.includes(d)) ||
    /this week|next week|schedule|what'?s on|who'?s working|who is working/.test(lower)
  ) {
    if (/next week/.test(lower)) {
      return weekAnswer(state, addDaysISO(mondayOf(today), 7), "Next week", showMoney);
    }
    if (/this week/.test(lower)) {
      return weekAnswer(state, mondayOf(today), "This week", showMoney);
    }
    if (/\btomorrow\b/.test(lower)) {
      return dayAnswer(state, addDaysISO(today, 1), showMoney);
    }
    for (const d of WEEKDAYS) {
      if (lower.includes(d)) {
        const date = nextWeekday(today, d);
        if (date) return dayAnswer(state, date, showMoney);
      }
    }
    return dayAnswer(state, today, showMoney);
  }

  // --- Money ---
  if (/how much|total|owed|owe|outstanding|unpaid|overdue|revenue|making|earned/.test(lower)) {
    if (!showMoney) {
      return {
        text: "Money totals are hidden for crew accounts — ask an admin or office user and they'll see them.",
        kind: "answer",
      };
    }
    if (/unpaid|overdue|owed|outstanding|owe/.test(lower)) {
      const open = state.invoices.filter((i) => i.status !== "paid");
      if (open.length === 0) {
        return { text: "Nothing outstanding — every invoice is paid.", kind: "answer", view: "invoices", viewLabel: "Open Invoices" };
      }
      const total = open.reduce((s, i) => s + invoiceTotal(i), 0);
      const lines = open
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .slice(0, 15)
        .map((i) => {
          const cust = state.customers.find((c) => c.id === i.customerId);
          return `• ${i.number} — ${cust ? customerName(cust) : "Unknown"} · ${money(invoiceTotal(i))} · due ${fmtDate(i.dueDate)} · ${i.status}`;
        })
        .join("\n");
      return {
        text: `Outstanding invoices: ${open.length} · ${money(total)} total\n${lines}${open.length > 15 ? `\n…and ${open.length - 15} more.` : ""}`,
        kind: "answer",
        view: "invoices",
        viewLabel: "Open Invoices",
      };
    }
    if (/this week/.test(lower)) {
      const monday = mondayOf(today);
      let total = 0;
      let count = 0;
      for (let i = 0; i < 7; i++) {
        const date = addDaysISO(monday, i);
        total += dayTotal(state, date);
        count += dayJobs(state, date).length;
      }
      return {
        text: `This week: ${count} jobs · ${money(total)} booked.`,
        kind: "answer",
        view: "schedule",
        viewLabel: "Open Schedule",
      };
    }
    if (/this month/.test(lower)) {
      const month = today.slice(0, 7);
      const jobs = state.jobs.filter((j) => j.date.startsWith(month));
      const total = jobs.reduce((s, j) => s + (jobValue(state, j) ?? 0), 0);
      return {
        text: `This month: ${jobs.length} jobs · ${money(total)} booked.`,
        kind: "answer",
        view: "schedule",
        viewLabel: "Open Schedule",
      };
    }
    if (/today/.test(lower)) {
      return {
        text: `Today: ${money(dayTotal(state, today))} booked across ${dayJobs(state, today).length} jobs.`,
        kind: "answer",
        view: "schedule",
        viewLabel: "Open Schedule",
      };
    }
    const open = state.invoices.filter((i) => i.status !== "paid");
    const openTotal = open.reduce((s, i) => s + invoiceTotal(i), 0);
    const accepted = state.estimates.filter((e) => e.status === "accepted");
    return {
      text:
        `Outstanding invoices: ${open.length} · ${money(openTotal)}.\n` +
        `Accepted estimates: ${accepted.length}.\n` +
        `This week booked: ${money([0, 1, 2, 3, 4, 5, 6].reduce((s, i) => s + dayTotal(state, addDaysISO(mondayOf(today), i)), 0))}.`,
      kind: "answer",
      view: "invoices",
      viewLabel: "Open Invoices",
    };
  }

  // --- Estimates waiting ---
  if (/estimate/.test(lower) && /waiting|pending|draft|sent|unapproved|open|outstanding/.test(lower)) {
    const waiting = state.estimates.filter(
      (e) => e.status !== "accepted" && e.status !== "closed",
    );
    if (waiting.length === 0) {
      return { text: "No estimates waiting — everything sent has been accepted.", kind: "answer", view: "estimates", viewLabel: "Open Estimates" };
    }
    const lines = waiting
      .sort((a, b) => b.createdDate.localeCompare(a.createdDate))
      .slice(0, 15)
      .map((e) => {
        const cust = state.customers.find((c) => c.id === e.customerId);
        const total = estimateTotals(e.lines, e.taxRate, e.discountType, e.discountValue).total;
        return `• ${e.title} — ${cust ? customerName(cust) : "Unknown"} · ${estimateStatusLabel(e.status)} · ${showMoney ? money(total) : ""}`;
      })
      .join("\n");
    return {
      text: `${waiting.length} estimate${waiting.length === 1 ? "" : "s"} waiting:\n${lines}${waiting.length > 15 ? `\n…and ${waiting.length - 15} more.` : ""}`,
      kind: "answer",
      view: "estimates",
      viewLabel: "Open Estimates",
    };
  }

  // --- Jobs for a customer ---
  if (/jobs for|work for|scheduled for/.test(lower)) {
    const matches = findCustomers(state, q);
    if (matches.length === 0) {
      return { text: "I couldn't find that customer — check the spelling.", kind: "answer", view: "customers", viewLabel: "Open Customers" };
    }
    const c = matches[0];
    const jobs = state.jobs
      .filter((j) => j.customerId === c.id)
      .sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
    if (jobs.length === 0) {
      return {
        text: `${customerName(c)} — no jobs on record yet.`,
        kind: "answer",
        customerId: c.id,
        view: "customers",
        viewLabel: "Open Customer",
      };
    }
    const lines = jobs.slice(0, 10).map((j) => `• ${fmtDay(j.date)} ${j.startTime} · ${j.title} · ${j.status}`).join("\n");
    return {
      text: `${customerName(c)} — ${jobs.length} job${jobs.length === 1 ? "" : "s"}:\n${lines}${jobs.length > 10 ? `\n…and ${jobs.length - 10} more.` : ""}`,
      kind: "answer",
      customerId: c.id,
      view: "customers",
      viewLabel: "Open Customer",
    };
  }

  // --- Customer lookup ---
  if (/find|show|who is|phone|address|contact|number for/.test(lower)) {
    const matches = findCustomers(state, q);
    if (matches.length === 0) {
      return {
        text: "I couldn't find anyone by that name — check the spelling, or add them from Customers → + New customer.",
        kind: "answer",
        view: "customers",
        viewLabel: "Open Customers",
      };
    }
    const c = matches[0];
    const jobs = state.jobs.filter((j) => j.customerId === c.id);
    const text =
      `${customerName(c)}${c.company ? ` · ${c.company}` : ""}\n` +
      `${c.address}, ${c.city} ${c.zip}\n` +
      `${c.phone || "No phone on file"}${c.email ? ` · ${c.email}` : ""}\n` +
      `${jobs.length} job${jobs.length === 1 ? "" : "s"} on record.` +
      (matches.length > 1 ? `\n\nAlso matched: ${matches.slice(1, 4).map(customerName).join(", ")}.` : "");
    return {
      text,
      kind: "answer",
      customerId: c.id,
      view: "customers",
      viewLabel: "Open Customer",
    };
  }

  // --- Counts ---
  if (/how many/.test(lower)) {
    if (/customer/.test(lower)) {
      return {
        text: `${state.customers.length} customers in the app (${state.customers.filter((c) => !isBlankCustomer(c)).length} with names).`,
        kind: "answer",
        view: "customers",
        viewLabel: "Open Customers",
      };
    }
    if (/job/.test(lower)) {
      return { text: `${state.jobs.length} jobs in the app.`, kind: "answer", view: "schedule", viewLabel: "Open Schedule" };
    }
    if (/estimate/.test(lower)) {
      return { text: `${state.estimates.length} estimates in the app.`, kind: "answer", view: "estimates", viewLabel: "Open Estimates" };
    }
    if (/invoice/.test(lower)) {
      return { text: `${state.invoices.length} invoices in the app.`, kind: "answer", view: "invoices", viewLabel: "Open Invoices" };
    }
    return {
      text: `${state.customers.length} customers, ${state.jobs.length} jobs, ${state.estimates.length} estimates, ${state.invoices.length} invoices.`,
      kind: "answer",
    };
  }

  // --- How do I... ---
  if (/how (do|can|to)|where (do|can|is)|what'?s the (best )?way/.test(lower)) {
    for (const h of HOW_TO) {
      if (h.match.test(lower)) {
        return {
          text: h.text.replaceAll(
            "{smsNumber}",
            smsNumber(state) || "your business number",
          ),
          kind: "answer",
        };
      }
    }
    return { text: `Here's what I can walk you through:\n• Adding a job, estimate, invoice, or customer\n• Mapping a customer's trees\n• Tracking hours and timesheets\n• Messaging a customer\n• Seeing a day's route\n\nAsk me, for example: "How do I add a job?"`, kind: "answer" };
  }

  // --- Fallback ---
  return {
    text: `I didn't catch that — I answer from your live data in this app. Try:\n\n${CAPABILITIES}`,
    kind: "answer",
  };
}
