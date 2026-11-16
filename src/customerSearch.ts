import type { Customer } from "./types";

/**
 * Customer search used everywhere a customer is looked up (Customers
 * page, the customer picker on estimates/jobs/invoices, Messages).
 *
 * Words match names, company, email, address and city as typed.
 * Phone numbers match on digits only, so "(555) 555-0199",
 * "555 555 0199", "555.555.0199", "+1 555 555 0199" and "5555550199"
 * all find a customer saved as 555-555-0199.
 */

/** Only the digits; a US number with a leading 1 (11 digits) drops the 1. */
export function phoneDigits(s: string | null | undefined): string {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

/** True when the query looks like (part of) a phone number. */
function looksLikePhone(q: string): boolean {
  return /^[\d\s()+.-]+$/.test(q) && q.replace(/\D/g, "").length >= 3;
}

export function customerText(c: Customer): string {
  return `${c.firstName} ${c.lastName} ${c.company} ${c.companyName ?? ""} ${c.projectName ?? ""} ${c.email} ${c.address} ${c.city} ${c.phone}`.toLowerCase();
}

export function customerMatches(c: Customer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (customerText(c).includes(q)) return true;
  if (looksLikePhone(q)) {
    const want = phoneDigits(q);
    const phones = [c.phone, ...(c.contacts ?? []).map((ct) => ct.phone)];
    return phones.some((p) => {
      const have = phoneDigits(p);
      return have !== "" && have.includes(want);
    });
  }
  return false;
}

/** "555-555-0199" → "tel:5555550199" (keeps a leading +). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/g, "")}`;
}

/** Address line without empty parts (no lone ","). */
export function addressLine(c: Pick<Customer, "address" | "city" | "zip">): string {
  const cityZip = [c.city, c.zip].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");
  return [(c.address ?? "").trim(), cityZip].filter(Boolean).join(", ");
}

