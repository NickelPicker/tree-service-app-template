/**
 * Licences & insurance: the rules behind the screen, no React here so
 * they are unit tested on their own.
 *
 * - Status of a document from its expiry date: Valid, Expires in N
 *   days (30 days or fewer), Expired, or No expiry date.
 * - Which documents the Dashboard reminds the office about.
 * - Which files may be uploaded (PDF, JPG, PNG; at most 5 MB, the same
 *   limit the database checks), and the base64 text they are stored as.
 */
import type { AppState, CompanyDocument, CompanyDocumentKind, CrewMember } from "./types";
import { daysBetweenISO } from "./utils";

export const DOCUMENT_KINDS: Array<{ id: CompanyDocumentKind; label: string }> = [
  { id: "business_licence", label: "Business licence" },
  { id: "arborist_certification", label: "Arborist certification" },
  { id: "liability_insurance", label: "General liability insurance" },
  { id: "workers_comp", label: "Workers' comp" },
  { id: "auto_insurance", label: "Auto insurance" },
  { id: "other", label: "Other" },
];

export function documentKindLabel(kind: CompanyDocumentKind | string): string {
  return DOCUMENT_KINDS.find((k) => k.id === kind)?.label ?? "Other";
}

export function isDocumentKind(v: unknown): v is CompanyDocumentKind {
  return DOCUMENT_KINDS.some((k) => k.id === v);
}

/** A document counts as "expiring soon" this many days ahead. */
export const EXPIRY_WARNING_DAYS = 30;

export type DocumentStatus =
  | { kind: "valid"; daysLeft: number }
  | { kind: "expiring"; daysLeft: number }
  | { kind: "expired"; daysAgo: number }
  | { kind: "no-expiry" };

/**
 * Status on `today` (YYYY-MM-DD). A document is good through its
 * expiry date: it expires the day after.
 */
export function documentStatus(
  doc: Pick<CompanyDocument, "expiryDate">,
  today: string,
): DocumentStatus {
  if (!doc.expiryDate) return { kind: "no-expiry" };
  const daysLeft = daysBetweenISO(today, doc.expiryDate);
  if (daysLeft < 0) return { kind: "expired", daysAgo: -daysLeft };
  if (daysLeft <= EXPIRY_WARNING_DAYS) return { kind: "expiring", daysLeft };
  return { kind: "valid", daysLeft };
}

/** The words on the status chip. */
export function documentStatusLabel(s: DocumentStatus): string {
  switch (s.kind) {
    case "valid":
      return "Valid";
    case "expiring":
      return s.daysLeft === 0
        ? "Expires today"
        : `Expires in ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"}`;
    case "expired":
      return "Expired";
    case "no-expiry":
      return "No expiry date";
  }
}

/** Who a document is for, in words. */
export function documentHolder(doc: Pick<CompanyDocument, "crewId">, crew: CrewMember[]): string {
  if (!doc.crewId) return "The business";
  return crew.find((c) => c.id === doc.crewId)?.name ?? "Former team member";
}

export interface DocumentReminder {
  doc: CompanyDocument;
  status: Extract<DocumentStatus, { kind: "expiring" | "expired" }>;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * True when the same document was added again with a later expiry date
 * that has not passed: the old one was renewed and needs no reminder.
 * "The same" means the same kind, holder (the business, or one team
 * member), name or number, and issuer, so two different policies of one
 * kind (one per vehicle, a city and a state licence) never silence each
 * other. "Other" documents are never matched to each other.
 */
export function isRenewed(
  doc: CompanyDocument,
  docs: CompanyDocument[] | undefined,
  today: string,
): boolean {
  if (doc.kind === "other" || !doc.expiryDate) return false;
  return (docs ?? []).some(
    (d) =>
      d.id !== doc.id &&
      d.kind === doc.kind &&
      (d.crewId ?? null) === (doc.crewId ?? null) &&
      norm(d.name) === norm(doc.name) &&
      norm(d.issuer) === norm(doc.issuer) &&
      (norm(doc.name) !== "" || norm(doc.issuer) !== "") &&
      !!d.expiryDate &&
      d.expiryDate > doc.expiryDate! &&
      documentStatus(d, today).kind !== "expired",
  );
}

/**
 * Documents expired or expiring within 30 days, most urgent first.
 * A renewed one (see isRenewed) is left out; the new one is reminded
 * about in its turn.
 */
export function documentReminders(
  docs: CompanyDocument[] | undefined,
  today: string,
): DocumentReminder[] {
  const out: DocumentReminder[] = [];
  for (const doc of docs ?? []) {
    if (isRenewed(doc, docs, today)) continue;
    const status = documentStatus(doc, today);
    if (status.kind === "expired" || status.kind === "expiring") out.push({ doc, status });
  }
  const left = (r: DocumentReminder) =>
    r.status.kind === "expired" ? -r.status.daysAgo : r.status.daysLeft;
  return out.sort((a, b) => left(a) - left(b));
}

/** Sort for the list: most urgent first, then no expiry, then by name. */
export function sortDocuments(docs: CompanyDocument[], today: string): CompanyDocument[] {
  const rank = (d: CompanyDocument) => {
    const s = documentStatus(d, today);
    if (s.kind === "expired") return -100000 - s.daysAgo;
    if (s.kind === "no-expiry") return 1000000;
    return s.daysLeft;
  };
  return [...docs].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

/** True when the company has a general liability insurance document that has not expired. */
export function hasLiabilityInsurance(state: Pick<AppState, "companyDocuments">, today: string): boolean {
  return (state.companyDocuments ?? []).some(
    (d) => d.kind === "liability_insurance" && documentStatus(d, today).kind !== "expired",
  );
}

// ---------- Uploads ----------

/** Same limit as the database check (company_document_files.size_bytes). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type StoredFileType = "application/pdf" | "image/jpeg" | "image/png";

const EXTENSION_TYPES: Record<string, StoredFileType | "heic"> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "heic",
  heif: "heic",
};

/**
 * What a chosen file is: a type we store as it is, "heic" (an iPhone
 * photo, converted to JPG before upload when the browser can read it),
 * or null (not allowed). Uses the browser's type, else the extension.
 */
export function uploadKind(file: { name: string; type: string }): StoredFileType | "heic" | null {
  const t = file.type.toLowerCase();
  if (t === "application/pdf" || t === "image/jpeg" || t === "image/png") return t;
  if (t === "image/jpg") return "image/jpeg";
  if (t === "image/heic" || t === "image/heif") return "heic";
  if (t && t !== "application/octet-stream") return null;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return EXTENSION_TYPES[ext] ?? null;
}

/** Why a file cannot be stored as it is, or null when it can. */
export function uploadProblem(file: { name: string; type: string; size: number }): string | null {
  const kind = uploadKind(file);
  if (!kind) return "Only PDF, JPG, PNG or iPhone (HEIC) photos can be uploaded.";
  if (file.size <= 0) return "That file is empty.";
  // Photos are made smaller before upload; a PDF cannot be.
  if (kind === "application/pdf" && file.size > MAX_FILE_BYTES) {
    return `That PDF is ${formatBytes(file.size)}; the limit is 5 MB. Try a smaller scan.`;
  }
  return null;
}

/** The first bytes of each stored type (the database checks the same). */
export function sniffType(bytes: Uint8Array): StoredFileType | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

/** Length of the base64 text for n bytes (what the database checks). */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A safe file name to store and download under. */
export function cleanFileName(name: string, type: StoredFileType): string {
  const ext = type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg";
  const base = name
    .replace(/\.[^.]*$/, "")
    .replace(/[^\w .()-]+/g, "_")
    .trim()
    .slice(0, 150);
  return `${base || "document"}.${ext}`;
}
