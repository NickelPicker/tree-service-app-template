import type { ComposedEmail } from "../email";

/**
 * Preview of the email the customer would receive: the full document
 * inside the email body as searchable text — never a PDF. An estimate
 * email shows its "Review and accept" button where the customer will
 * see it (the private link itself is made when the email is sent). An
 * invoice email shows its "Review us" button only when the sender asked
 * for a review.
 */
export default function EmailPreview({ email }: { email: ComposedEmail }) {
  // The text version writes the button as "Review and accept: <link>".
  // An invoice email asked to carry a review writes "Review us: <link>".
  const parts = email.acceptButton
    ? email.body.split(/^Review and accept: .*$/m)
    : email.reviewButton
      ? email.body.split(/^Review us: .*$/m)
      : [email.body];
  return (
    <div className="rounded-xl border border-slate-200 bg-white pb-16 shadow-sm">
      <div className="border-b border-slate-100 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Email preview — what the customer will receive
        </p>
        <p className="mt-1 text-sm text-slate-700">
          <span className="font-semibold">To:</span> {email.to || "(no email on file)"}
        </p>
        <p className="text-sm text-slate-700">
          <span className="font-semibold">Subject:</span> {email.subject}
        </p>
      </div>
      <div className="px-4 py-3 text-sm leading-relaxed text-slate-800">
        <p className="whitespace-pre-wrap">{parts[0].trimEnd()}</p>
        {parts.length > 1 && email.reviewButton && (
          <>
            <p className="my-3">
              <a
                href={email.reviewButton}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block rounded-lg bg-[#b45309] px-5 py-3 font-bold text-white"
              >
                Review us
              </a>
              <span className="mt-1 block break-all text-xs text-slate-500">
                Opens {email.reviewButton}
              </span>
            </p>
            <p className="whitespace-pre-wrap">{parts.slice(1).join("").trim()}</p>
          </>
        )}
        {parts.length > 1 && !email.reviewButton && (
          <>
            <p className="my-3">
              <span className="inline-block rounded-lg bg-[#2f6b40] px-5 py-3 font-bold text-white">
                Review and accept
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                The button opens the customer&apos;s own private page. It is
                made when you press Email.
              </span>
            </p>
            <p className="whitespace-pre-wrap">{parts.slice(1).join("").trim()}</p>
          </>
        )}
      </div>
    </div>
  );
}
