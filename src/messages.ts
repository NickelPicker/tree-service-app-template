import type { CrewMember, Customer, Message } from "./types";

/**
 * Shared customer Communications: central number + personal intros.
 *
 * - The customer only ever gets texts from ONE number, the central
 *   business number from the company profile (see src/company.ts:
 *   the texting number the setup wizard asks for). A crew member's
 *   personal phone is never shown to the customer as the sender —
 *   not in the queued-send preview, and (in Phase 2) not in the real
 *   Twilio send either.
 * - Inside the app the thread is groupchat-like: every company
 *   member sees the same chronological thread per customer, and each
 *   message shows who sent it. The name the customer sees is the
 *   sender's name inside the message body (SMS carries no display
 *   name), which is what the personal intro provides.
 * - Sending is QUEUED ONLY in this preview: nothing leaves the
 *   browser. Real Twilio SMS + Gmail sync is Phase 2.
 */

/**
 * Placeholder syntax for a personal message intro.
 *
 * - {firstName} — the customer's first name ("Sarah")
 * - {customer} — the customer's full name ("Jane Doe")
 * - {senderName} / {name} — the sender's name ("Miguel")
 * - {senderFirstName} — the sender's first name ("Miguel")
 *
 * Unknown {placeholders} are left untouched, so a typo never eats
 * part of someone's intro.
 */
export function defaultMessageIntro(
  senderName: string,
  companyName = "Your Tree Service",
): string {
  return `Hi {firstName}, this is ${senderName} with ${companyName}:`;
}

/** The raw intro template a person has written, or the default. */
export function rawMessageIntro(
  member: CrewMember | null | undefined,
  companyName = "Your Tree Service",
): string {
  const written = member?.messageIntro?.trim();
  if (written) return written;
  return defaultMessageIntro(member?.name ?? companyName, companyName);
}

/** Render an intro template for one customer + sender. */
export function renderMessageIntro(
  template: string,
  customer: Customer | null | undefined,
  sender: CrewMember | null | undefined,
  companyName = "Your Tree Service",
): string {
  const senderName = sender?.name ?? companyName;
  const senderFirst = senderName.split(" ")[0] ?? senderName;
  const customerName = customer
    ? `${customer.firstName} ${customer.lastName}`.trim()
    : "there";
  return template
    .replaceAll("{firstName}", customer?.firstName ?? "there")
    .replaceAll("{customer}", customerName)
    .replaceAll("{senderName}", senderName)
    .replaceAll("{senderFirstName}", senderFirst)
    .replaceAll("{name}", senderName);
}

/** The rendered intro that autofills the composer for this sender. */
export function introForComposer(
  member: CrewMember | null | undefined,
  customer: Customer | null | undefined,
  companyName = "Your Tree Service",
): string {
  return renderMessageIntro(
    rawMessageIntro(member, companyName),
    customer,
    member,
    companyName,
  );
}

/**
 * Does `body` already start with this intro (ignoring leading space
 * and case)? Used so the composer never double-prepends an intro the
 * user already has in the text.
 */
export function startsWithIntro(body: string, intro: string): boolean {
  const b = body.trimStart().toLowerCase();
  const i = intro.trim().toLowerCase();
  return i !== "" && b.startsWith(i);
}

/** Sort a customer's messages oldest-first, for the thread view. */
export function threadMessages(messages: Message[], customerId: string): Message[] {
  return messages
    .filter((m) => m.customerId === customerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The latest message in a customer's thread, or null when none. */
export function latestMessage(
  messages: Message[],
  customerId: string,
): Message | null {
  const thread = threadMessages(messages, customerId);
  return thread.length ? thread[thread.length - 1] : null;
}
