// compose.ts — builds the "Your day" emails, one per crew member.
//
// Pure code with no Deno or browser globals, so the edge function
// (index.ts) and the app's vitest tests both import it. Rows use the
// database's column names (snake_case) exactly as Supabase returns them.

export interface JobRow {
  id: string;
  title: string | null;
  date: string;
  end_date?: string | null;
  start_time: string | null;
  customer_id: string | null;
  address_id?: string | null;
  crew_ids: string[] | null;
  equipment_ids?: string[] | null;
  equipment_drivers?: Record<string, string> | null;
  crew_arrivals?: Record<string, string> | null;
  team_notes?: string | null;
  status?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface CrewRow {
  id: string;
  name: string | null;
  email: string | null;
}

export interface EquipmentRow {
  id: string;
  name: string | null;
}

export interface CustomerRow {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  address?: string | null;
  city?: string | null;
  zip?: string | null;
}

export interface AddressRow {
  id: string;
  customer_id: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  is_primary: boolean | null;
}

export interface DayPlanInput {
  /** "YYYY-MM-DD" */
  date: string;
  jobs: JobRow[];
  crew: CrewRow[];
  equipment: EquipmentRow[];
  customers: CustomerRow[];
  addresses: AddressRow[];
}

export interface DayPlanEmail {
  crewId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface DayPlanEmails {
  emails: DayPlanEmail[];
  /** People on a job that day with no email address saved. */
  skippedNoEmail: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when the job runs on `date` (single day, or inside a multi-day span). */
export function jobOnDay(j: JobRow, date: string): boolean {
  if (j.date === date) return true;
  return !!j.end_date && j.date <= date && j.end_date >= date;
}

/** "2026-11-16" -> "Monday, November 16". */
export function weekdayDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "07:30" -> "7:30 AM"; blank or odd input -> "" / as-is. */
export function niceTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = parseInt(m[1], 10);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** When this person gets to this job: their own arrival time, else the job's start. */
export function arrivalFor(j: JobRow, crewId: string): string {
  return j.crew_arrivals?.[crewId] || j.start_time || "";
}

function joinParts(parts: (string | null | undefined)[], sep: string): string {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(sep);
}

/** The job's address: the chosen customer address, else the primary one, else the customer's own address fields. */
export function jobAddress(
  j: JobRow,
  customers: CustomerRow[],
  addresses: AddressRow[],
): string {
  const mine = addresses.filter((a) => a.customer_id === j.customer_id);
  const picked =
    (j.address_id ? mine.find((a) => a.id === j.address_id) : undefined) ??
    mine.find((a) => a.is_primary) ??
    mine[0];
  if (picked) {
    // A town without a street would send the crew to the middle of town;
    // leave it blank so the directions use the job's map pin instead.
    if (!(picked.street ?? "").trim()) return "";
    return joinParts(
      [picked.street, joinParts([picked.city, picked.state], ", "), picked.zip],
      ", ",
    );
  }
  const c = customers.find((x) => x.id === j.customer_id);
  if (!c) return "";
  return joinParts([c.address, c.city, c.zip], ", ");
}

/** Google Maps directions to the job (address first, else the pin). */
export function mapsLink(address: string, j: JobRow): string {
  const dest =
    address !== ""
      ? address
      : j.lat != null && j.lng != null
        ? `${j.lat},${j.lng}`
        : "";
  if (dest === "") return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Stop {
  time: string;
  title: string;
  address: string;
  maps: string;
  others: string[];
  drives: string[];
  notes: string;
}

function personName(crew: CrewRow[], id: string): string {
  return crew.find((c) => c.id === id)?.name?.trim() || "Someone";
}

function stopsFor(input: DayPlanInput, jobs: JobRow[], crewId: string): Stop[] {
  return jobs
    .filter((j) => (j.crew_ids ?? []).includes(crewId))
    .map((j) => ({ j, at: arrivalFor(j, crewId) }))
    .sort((a, b) => (a.at || "99:99").localeCompare(b.at || "99:99") || a.j.id.localeCompare(b.j.id))
    .map(({ j, at }) => {
      const address = jobAddress(j, input.customers, input.addresses);
      const drives = Object.entries(j.equipment_drivers ?? {})
        .filter(([, who]) => who === crewId)
        .map(([eqId]) => input.equipment.find((e) => e.id === eqId)?.name?.trim() || "")
        .filter(Boolean);
      return {
        time: niceTime(at),
        title: (j.title ?? "").trim() || "Job",
        address,
        maps: mapsLink(address, j),
        others: (j.crew_ids ?? []).filter((id) => id !== crewId).map((id) => personName(input.crew, id)),
        drives,
        notes: (j.team_notes ?? "").trim(),
      };
    });
}

function textBody(name: string, day: string, stops: Stop[]): string {
  const lines: string[] = [`Hi ${name},`, "", `Here is your day for ${day}.`, ""];
  stops.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.time ? `${s.time} — ` : ""}${s.title}`);
    if (s.address) lines.push(`   Where: ${s.address}`);
    if (s.maps) lines.push(`   Directions: ${s.maps}`);
    lines.push(`   With: ${s.others.length ? s.others.join(", ") : "Just you"}`);
    if (s.drives.length) lines.push(`   You drive: ${s.drives.join(", ")}`);
    if (s.notes) lines.push(`   Team notes: ${s.notes}`);
    lines.push("");
  });
  lines.push("Open the app for details.");
  return lines.join("\n");
}

function htmlBody(name: string, day: string, stops: Stop[]): string {
  const e = escapeHtml;
  const items = stops
    .map((s) => {
      const rows = [
        s.address ? `<div>Where: ${e(s.address)}</div>` : "",
        s.maps ? `<div><a href="${e(s.maps)}">Directions in Google Maps</a></div>` : "",
        `<div>With: ${e(s.others.length ? s.others.join(", ") : "Just you")}</div>`,
        s.drives.length ? `<div>You drive: ${e(s.drives.join(", "))}</div>` : "",
        s.notes ? `<div>Team notes: ${e(s.notes).replace(/\n/g, "<br>")}</div>` : "",
      ].join("");
      return `<li style="margin-bottom:16px"><strong>${s.time ? `${e(s.time)} — ` : ""}${e(s.title)}</strong>${rows}</li>`;
    })
    .join("");
  return (
    `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.4;color:#222">` +
    `<p>Hi ${e(name)},</p><p>Here is your day for ${e(day)}.</p>` +
    `<ol style="padding-left:20px">${items}</ol>` +
    `<p style="color:#555">Open the app for details.</p></div>`
  );
}

/** One email per crew member who is on at least one job that day and has an email. */
export function composeDayPlanEmails(input: DayPlanInput): DayPlanEmails {
  const jobs = input.jobs.filter((j) => jobOnDay(j, input.date));
  const onJobs = new Set<string>();
  for (const j of jobs) for (const id of j.crew_ids ?? []) onJobs.add(id);
  const day = weekdayDate(input.date);
  const emails: DayPlanEmail[] = [];
  let skippedNoEmail = 0;
  for (const crewId of [...onJobs].sort()) {
    const person = input.crew.find((c) => c.id === crewId);
    const to = (person?.email ?? "").trim();
    if (!person || !EMAIL_RE.test(to)) {
      skippedNoEmail++;
      continue;
    }
    const stops = stopsFor(input, jobs, crewId);
    const name = person.name?.trim().split(/\s+/)[0] || "there";
    emails.push({
      crewId,
      to,
      subject: `Your day — ${day}`,
      text: textBody(name, day, stops),
      html: htmlBody(name, day, stops),
    });
  }
  return { emails, skippedNoEmail };
}

/**
 * How many crew members "Email everyone their day" would email for
 * `date`: everyone on a job that day (finished jobs left out, as the
 * function does) whose roster card has a usable email. `crew` must be
 * the active crew only. The app asks the owner's double confirm when
 * this is more than 3, and the function refuses more than 3 unless the
 * call says that many were confirmed.
 */
export function dayPlanRecipientCount(date: string, jobs: JobRow[], crew: CrewRow[]): number {
  const onJobs = new Set<string>();
  for (const j of jobs) {
    if (j.status === "done" || !jobOnDay(j, date)) continue;
    for (const id of j.crew_ids ?? []) onJobs.add(id);
  }
  let n = 0;
  for (const id of onJobs) {
    const person = crew.find((c) => c.id === id);
    if (person && EMAIL_RE.test((person.email ?? "").trim())) n++;
  }
  return n;
}

/**
 * The sends-log key of one crew member's day-plan email: the day, the
 * person and a hash of exactly what they would get. An unchanged plan
 * has the same key, so it is not emailed again; any change to their
 * email is a new key.
 */
export function dayPlanDedupeKey(date: string, crewId: string, contentHash: string): string {
  return `day_plan:${date}:${crewId}:${contentHash.slice(0, 32)}`;
}

/** What the content hash covers: address, subject and the text body. */
export function dayPlanHashInput(m: { to: string; subject: string; text: string }): string {
  return `${m.to.trim().toLowerCase()}\n${m.subject}\n${m.text}`;
}

/** A sends-log row for one of this press's keys. */
export interface DayPlanLogRow {
  dedupe_key: string;
  status: string;
  attempts: number;
}

/** Same as claim_automation_send: a failed row is retried until 3 tries. */
export const DAY_PLAN_MAX_TRIES = 3;

/**
 * Sorts this press's emails before anything is claimed:
 *   unchanged  already sent (or being sent) exactly this email
 *   blocked    test mode refuses the address: not claimed, uses no try
 *   failed     this exact email failed 3 times already: not claimed
 *   toSend     the rest
 */
export function planDayPlanSends<T extends { key: string; to: string }>(
  items: T[],
  rows: DayPlanLogRow[],
  allowed: (to: string) => boolean,
): { toSend: T[]; unchanged: number; blocked: number; failed: number } {
  const byKey = new Map(rows.map((r) => [r.dedupe_key, r]));
  const toSend: T[] = [];
  let unchanged = 0;
  let blocked = 0;
  let failed = 0;
  for (const it of items) {
    const row = byKey.get(it.key);
    if (row && (row.status === "sent" || row.status === "sending")) unchanged++;
    else if (!allowed(it.to)) blocked++;
    else if (row && row.status === "failed" && row.attempts >= DAY_PLAN_MAX_TRIES) failed++;
    else toSend.push(it);
  }
  return { toSend, unchanged, blocked, failed };
}
