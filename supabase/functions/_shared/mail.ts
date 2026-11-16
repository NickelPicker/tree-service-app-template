// mail.ts — the business Gmail, shared by the edge functions.
//
// Sends through smtp.gmail.com:465 as the business Gmail address in the
// function secret GMAIL_ADDRESS, with the function secret
// GMAIL_APP_PASSWORD, and shows SENDER_NAME as the sender. The deploy
// workflow sets all three from the GitHub variables GMAIL_ADDRESS and
// BUSINESS_NAME and the GitHub secret GMAIL_APP_PASSWORD. Until the
// address and the password both exist, gmailPassword() is "" and callers
// send nothing.
// Never logs addresses, names or SMTP error text (it can hold them).

// @deno-types="npm:@types/nodemailer@6.4.17"
import nodemailer from "npm:nodemailer@6.9.16";
import { mailErrorKind, type SendResult } from "./mailErrors.ts";
import { recipientAllowed } from "./testMode.ts";

export type { SendResult } from "./mailErrors.ts";

/** The business Gmail address ("" until the deploy sets GMAIL_ADDRESS). */
export const GMAIL_ADDRESS = (Deno.env.get("GMAIL_ADDRESS") ?? "").trim().toLowerCase();
/** The name customers see as the sender (no quotes or angle brackets). */
const SENDER_NAME = (Deno.env.get("SENDER_NAME") ?? "").replace(/["<>\r\n]/g, "").trim() || "Tree Service";
export const FROM = `"${SENDER_NAME}" <${GMAIL_ADDRESS}>`;

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** True when Gmail accepted the email. Never throws. */
  send(m: OutgoingMail): Promise<boolean>;
  /**
   * "sent", "failed" (this email only) or "account" (Gmail refused the
   * whole account or could not be reached; see mailErrors.ts). Never throws.
   */
  sendDetailed(m: OutgoingMail): Promise<SendResult>;
  close(): void;
}

/** The Gmail app password, or "" while it (or the address) is not set up. */
export function gmailPassword(): string {
  if (!GMAIL_ADDRESS.includes("@")) return "";
  return (Deno.env.get("GMAIL_APP_PASSWORD") ?? "").trim();
}

/** A Gmail sender; call only with a non-empty password. */
export function openMailer(password: string): Mailer {
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: GMAIL_ADDRESS, pass: password },
  });
  async function sendDetailed(m: OutgoingMail): Promise<SendResult> {
    // Test mode (testMode.ts): only the business Gmail and the owner's
    // test addresses receive anything; the rest is refused here, before
    // Gmail is contacted, and reported as not sent.
    if (
      !recipientAllowed(
        m.to,
        Deno.env.get("EMAIL_TEST_MODE"),
        GMAIL_ADDRESS,
        Deno.env.get("EMAIL_TEST_RECIPIENTS"),
      )
    ) {
      return "failed";
    }
    try {
      await transport.sendMail({
        from: FROM,
        replyTo: GMAIL_ADDRESS,
        to: m.to,
        subject: m.subject,
        text: m.text,
        html: m.html,
      });
      return "sent";
    } catch (err) {
      return mailErrorKind(err);
    }
  }
  return {
    async send(m: OutgoingMail): Promise<boolean> {
      return (await sendDetailed(m)) === "sent";
    },
    sendDetailed,
    close() {
      transport.close();
    },
  };
}
