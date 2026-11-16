import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { MessageChannel } from "../types";
import { introForComposer, startsWithIntro, threadMessages } from "../messages";
import { companyName, smsNumber } from "../company";
import { fmtDateTime } from "../utils";
import { isOwnerLike } from "../permissions";
import { inputCls, labelCls, linkCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * Shared Communications thread for one customer — groupchat-like for
 * the team, one number for the customer.
 *
 * - Every company member sees the same chronological thread.
 * - Outbound SMS always shows as from the central business number
 *   (the texting number on the company profile), never a crew
 *   member's personal phone.
 * - Each message shows who sent it, when, and the channel.
 * - The composer prefills with the viewer's own personal intro
 *   (rendered for this customer). The viewer can edit or delete it
 *   for that one message; it is never double-prepended.
 * - Sending is owner-gated per person: the "Can message customers"
 *   switch on the person's Team card. When it is off for the viewer,
 *   only "Log a call" is offered (to people who edit customers), and
 *   an owner or manager gets a one-tap "Turn on" for themselves.
 * - Texts and emails typed here are saved in the thread and the
 *   activity log only: sending them from the app is not set up yet,
 *   and the screen says so in plain words.
 */
export default function MessageThread({
  customerId,
  initialChannel = "sms",
}: {
  customerId: string;
  initialChannel?: MessageChannel;
}) {
  const {
    state,
    viewer,
    viewerName,
    canMessageCustomers,
    canEdit,
    sendMessage,
    openJob,
    openEstimate,
    openCustomer,
    saveCrewMember,
  } = useStore();
  const [channel, setChannel] = useState<MessageChannel>(initialChannel);
  const [body, setBody] = useState("");
  const [jobId, setJobId] = useState<string>("");
  const [queuedNote, setQueuedNote] = useState<string | null>(null);
  const prefillKeyRef = useRef<string>("");
  const endRef = useRef<HTMLDivElement | null>(null);

  const customer = state?.customers.find((c) => c.id === customerId) ?? null;
  const messages = state ? threadMessages(state.messages ?? [], customerId) : [];
  const jobs = (state?.jobs ?? [])
    .filter((j) => j.customerId === customerId)
    .sort((a, b) => b.date.localeCompare(a.date));
  const intro = introForComposer(viewer, customer, companyName(state));

  // Prefill the composer with the viewer's own intro whenever the
  // customer, viewer, or channel changes — never while typing.
  // The key guard means clearing the box does not re-prefill it.
  const prefillKey = `${customerId}|${viewer?.id ?? ""}|${channel}`;
  useEffect(() => {
    if (!customer) return;
    if (prefillKeyRef.current === prefillKey) return;
    prefillKeyRef.current = prefillKey;
    // A logged call is notes, not a message: no intro.
    setBody(channel === "call" ? "" : introForComposer(viewer, customer, companyName(state)));
    setJobId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);

  // Keep the latest message in view when the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  if (!state) return null;
  if (!customer) return <p className="text-sm text-slate-500">Customer not found.</p>;

  const channelLabel = (m: { channel: MessageChannel }) =>
    m.channel === "sms" ? "SMS" : m.channel === "email" ? "Email" : "Call";
  const linkedJob = (jobIdValue: string | null) =>
    jobIdValue ? state.jobs.find((j) => j.id === jobIdValue) ?? null : null;
  const linkedEstimate = (estimateId: string | null | undefined) =>
    estimateId ? state.estimates.find((e) => e.id === estimateId) ?? null : null;

  // Logging a call sends nothing, so anyone who can edit customers may
  // always do it; texts and emails follow the messaging switch.
  // Without the messaging switch, a person who edits customers can
  // still log calls; nobody else gets a text box at all.
  const composerChannel: MessageChannel = canMessageCustomers ? channel : "call";
  const canSendThis = canMessageCustomers || (composerChannel === "call" && canEdit);
  const showComposer = canMessageCustomers || canEdit;
  const ownerLike = isOwnerLike(viewer?.appRole);
  const realViewer = viewer && !viewer.id.startsWith("auth:")
    ? (state?.crew.find((c) => c.id === viewer.id) ?? null)
    : null;
  const turnOnForMe = () => {
    if (!realViewer) return;
    saveCrewMember({
      ...realViewer,
      permissions: { ...(realViewer.permissions ?? {}), canMessageCustomers: true },
    });
  };

  const handleSend = () => {
    const text = body.trim();
    if (!text || !canSendThis) return;
    sendMessage({
      customerId,
      channel: composerChannel,
      body: text,
      jobId: jobId || null,
      estimateId: null,
    });
    setQueuedNote(
      composerChannel === "call"
        ? "Call logged in this thread."
        : "Saved in this thread. The customer has not been sent it: sending from here is not set up yet.",
    );
    // Fresh composer for the next message, prefilled with the intro.
    prefillKeyRef.current = "";
    setBody(composerChannel === "call" ? "" : introForComposer(viewer, customer, companyName(state)));
    setJobId("");
  };

  const reinsertIntro = () => {
    if (startsWithIntro(body, intro)) return;
    setBody((prev) => (prev.trim() ? `${intro} ${prev.trimStart()}` : intro));
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        One shared thread for {customer.firstName} — the whole team sees
        the same messages. Texts go out from{" "}
        <span className="font-semibold text-slate-700">{smsNumber(state) || "your business number"}</span>{" "}
        only; personal phone numbers are never shown to the customer.
      </p>

      {messages.length === 0 ? (
        <p className="text-sm text-slate-500">
          No messages yet. Start the thread below — your intro is filled
          in for you.
        </p>
      ) : (
        <ul className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {messages.map((m) => {
            const out = m.direction === "out";
            const job = linkedJob(m.jobId);
            const estimate = linkedEstimate(m.estimateId);
            return (
              <li
                key={m.id}
                className={`rounded-xl px-3 py-2 text-sm ${
                  out
                    ? "ml-6 bg-emerald-50 text-slate-800"
                    : "mr-6 bg-slate-100 text-slate-800"
                }`}
              >
                <p className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <span>
                    <span className="font-semibold text-slate-700">
                      {out ? m.senderName : customer.firstName}
                    </span>
                    {" · "}
                    {channelLabel(m)} · {fmtDateTime(m.createdAt)}
                    {m.queued && (
                      <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
                        Queued
                      </span>
                    )}
                  </span>
                  <span>
                    {m.channel === "sms"
                      ? out
                        ? `From ${m.fromNumber ?? smsNumber(state) ?? "—"}`
                        : `To ${m.fromNumber ?? smsNumber(state) ?? "—"}`
                      : m.channel === "email"
                        ? out
                          ? "Via business email"
                          : "Reply by email"
                        : "Logged call"}
                  </span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words">{m.body}</p>
                {(job || estimate) && (
                  <p className="mt-2 flex flex-wrap gap-3 text-xs">
                    {job && (
                      <button onClick={() => openJob(job.id)} className={linkCls()}>
                        Job: {job.title}
                      </button>
                    )}
                    {estimate && (
                      <button
                        onClick={() => openEstimate(estimate.id)}
                        className={linkCls()}
                      >
                        Estimate: {estimate.title}
                      </button>
                    )}
                  </p>
                )}
              </li>
            );
          })}
          <div ref={endRef} />
        </ul>
      )}

      {!canMessageCustomers && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          <span className="min-w-0 flex-1">
            {ownerLike
              ? "Messaging customers is off for you."
              : canEdit
                ? "You can log calls here. To text or email customers, ask an owner to turn on messaging for you."
                : "Ask an owner if you need to message customers."}
          </span>
          {ownerLike && realViewer && (
            <button onClick={turnOnForMe} className={`${primaryBtn()} min-h-11`}>
              Turn on
            </button>
          )}
        </div>
      )}

      {showComposer && (
      <div className="min-w-0 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex flex-wrap gap-2">
            {canMessageCustomers && (
            <div>
              <label className={labelCls()}>Channel</label>
              <select
                className={inputCls()}
                value={channel}
                onChange={(e) => setChannel(e.target.value as MessageChannel)}
              >
                <option value="sms">Text (SMS)</option>
                <option value="email">Email</option>
                <option value="call">Log a call</option>
              </select>
            </div>
            )}
            <div className="min-w-0 flex-1 basis-40">
              <label className={labelCls()}>Link to job (optional)</label>
              <select
                className={inputCls()}
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
              >
                <option value="">No job link</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title} · {j.date}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls()}>
              {composerChannel === "sms"
                ? `Message — sends from ${smsNumber(state) || "your business number"}`
                : composerChannel === "email"
                  ? `Message — to ${customer.email || "(no email on file)"}`
                  : "Call notes — logged in this thread, not sent"}
            </label>
            <textarea
              className={inputCls()}
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={composerChannel === "call" ? "What was said on the call" : intro}
            />
            {composerChannel !== "call" && (
            <p className="mt-1 text-xs text-slate-500">
              Prefilled with your personal intro as {viewerName}. Edit or
              delete it for this message if you like — it stays yours for
              next time.{" "}
              {!startsWithIntro(body, intro) && body.trim() !== "" && (
                <button onClick={reinsertIntro} className={linkCls()}>
                  Put my intro back
                </button>
              )}
              {body.trim() === "" && (
                <button onClick={() => setBody(intro)} className={linkCls()}>
                  Use my intro
                </button>
              )}
            </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleSend}
              disabled={!body.trim() || !canSendThis}
              className={primaryBtn()}
            >
              {composerChannel === "call" ? "Log call" : "Save to thread"}
            </button>
            <button
              onClick={() => openCustomer(customer.id)}
              className={secondaryBtn()}
            >
              Open customer
            </button>
          </div>
          {queuedNote && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {queuedNote}
            </p>
          )}
          {composerChannel !== "call" && (
            <p className="text-xs text-slate-500">
              Texts and emails typed here are saved in this thread for the
              team. They are not sent to the customer yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
