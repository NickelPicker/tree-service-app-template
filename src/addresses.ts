import type { Customer, CustomerAddress } from "./types";
import { uid } from "./utils";

/**
 * Multiple addresses per customer + the duplicate safeguard.
 *
 * The legacy address/city/zip fields on Customer always mirror the
 * primary address (saveCustomer keeps them in sync), so older code,
 * imports, and search keep working. Everything new goes through the
 * helpers here.
 */

/** All addresses on a customer, primary first. Old rows with no list get one synthesized from the legacy fields. */
export function customerAddresses(c: Customer | null | undefined): CustomerAddress[] {
  if (!c) return [];
  const list = (c.addresses ?? []).filter((a) => a.street.trim() !== "" || a.label.trim() !== "");
  if (list.length > 0) {
    const primary = list.find((a) => a.isPrimary);
    return primary
      ? [primary, ...list.filter((a) => a.id !== primary.id)]
      : list;
  }
  if (c.address.trim() === "" && c.city.trim() === "" && c.zip.trim() === "") {
    return [];
  }
  return [
    {
      id: "legacy",
      label: "Home",
      street: c.address,
      city: c.city,
      state: "CO",
      zip: c.zip,
      isPrimary: true,
    },
  ];
}

/** The primary address, or null when the customer has no address at all. */
export function primaryAddress(
  c: Customer | null | undefined,
): CustomerAddress | null {
  return customerAddresses(c)[0] ?? null;
}

/** One-line address: "123 Main St, Anytown, CO 12319". */
export function addressLine(a: CustomerAddress): string {
  const parts = [
    a.street.trim(),
    [a.city.trim(), a.state.trim()].filter(Boolean).join(", "),
    a.zip.trim(),
  ].filter(Boolean);
  return parts.join(", ");
}

/** "Home — 123 Main St, Anytown, CO 12319" (label omitted when blank). */
export function addressDisplay(a: CustomerAddress): string {
  const line = addressLine(a);
  return a.label.trim() !== "" ? `${a.label.trim()} — ${line}` : line;
}

/** A blank address row for the editor. */
export function blankAddress(isPrimary: boolean): CustomerAddress {
  return {
    id: uid(),
    label: "",
    street: "",
    city: "",
    state: "CO",
    zip: "",
    isPrimary,
  };
}

/** The address a job is at: the chosen one, else the primary. */
export function jobCustomerAddress(
  c: Customer | null | undefined,
  addressId: string | null | undefined,
): CustomerAddress | null {
  const list = customerAddresses(c);
  if (addressId) {
    const chosen = list.find((a) => a.id === addressId);
    if (chosen) return chosen;
  }
  return list[0] ?? null;
}

// ---------- Duplicate safeguard ----------

function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function normPhone(s: string): string {
  const digits = s.replace(/\D/g, "");
  // 1 + 10 digits (US country code) collapses to the 10-digit number.
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;
}

function normEmail(s: string): string {
  return s.toLowerCase().trim();
}

function normStreet(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface DuplicateMatch {
  customer: Customer;
  /** Why it matched, in plain words ("same name + phone"). */
  reasons: string[];
}

export interface DuplicateDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  address: string;
}

/**
 * Customers already in the system that look like the same person as
 * the draft being added. Any one of these matches: same name + email,
 * same name + phone, same name + street, same email alone, or same
 * phone alone. The caller shows the matches and lets the user pick
 * the existing customer or add anyway — this never blocks on its own.
 */
export function findDuplicates(
  customers: Customer[],
  draft: DuplicateDraft,
  excludeId?: string,
): DuplicateMatch[] {
  const name = normName(`${draft.firstName} ${draft.lastName}`);
  const phone = normPhone(draft.phone);
  const email = normEmail(draft.email);
  const street = normStreet(draft.address);
  const out: DuplicateMatch[] = [];
  for (const c of customers) {
    if (excludeId && c.id === excludeId) continue;
    const reasons: string[] = [];
    const cName = normName(`${c.firstName} ${c.lastName}`);
    const cPhone = normPhone(c.phone);
    const cEmail = normEmail(c.email);
    const cStreet = normStreet(c.address);
    const sameName = name !== "" && cName !== "" && name === cName;
    const sameEmail = email !== "" && cEmail !== "" && email === cEmail;
    const samePhone = phone !== "" && cPhone !== "" && phone === cPhone;
    const sameStreet =
      street !== "" && cStreet !== "" && street === cStreet;
    if (sameName && sameEmail) reasons.push("same name + email");
    if (sameName && samePhone) reasons.push("same name + phone");
    if (sameName && sameStreet) reasons.push("same name + address");
    if (sameEmail && !sameName) reasons.push("same email");
    if (samePhone && !sameName) reasons.push("same phone");
    if (reasons.length > 0) out.push({ customer: c, reasons });
  }
  return out;
}

/**
 * True when a booking's typed address is not one of the customer's
 * addresses on file (so the office and crew are told which place was
 * booked). A blank booking address never differs.
 */
export function bookedAddressDiffers(c: Customer, booked: string): boolean {
  const b = normStreet(booked);
  if (b === "") return false;
  const streets = customerAddresses(c)
    .map((a) => normStreet(a.street))
    .filter((s) => s !== "");
  return !streets.some((s) => b === s || b.startsWith(`${s} `));
}
