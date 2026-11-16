import { useState } from "react";
import { useStore } from "../store";
import { fmtDateTime, uid } from "../utils";
import { inputCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * The shared Team note box, first on the customer page: notes the
 * whole team sees ("wants Tuesday, gate code 1234"), plus "Log a
 * call", which records the call in the customer's shared thread.
 * Logging a call sends nothing, so it never needs the messaging
 * switch. Anyone who can edit customers can write here; everyone who
 * can see the customer reads it (database rule: private_notes kind
 * 'team').
 */
const SHOWN = 3;

export default function TeamNotes({ customerId }: { customerId: string }) {
  const {
    state,
    canEdit,
    role,
    viewerName,
    addPrivateNote,
    deletePrivateNote,
    sendMessage,
  } = useStore();
  const [text, setText] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!state) return null;

  const notes = state.notes
    .filter((n) => n.customerId === customerId && n.kind === "team")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shown = showAll ? notes : notes.slice(0, SHOWN);
  const isAdmin = role === "owner" || role === "manager";

  const addNote = () => {
    const t = text.trim();
    if (!t) return;
    addPrivateNote({
      id: uid(),
      customerId,
      kind: "team",
      author: viewerName,
      createdAt: new Date().toISOString(),
      text: t,
    });
    setText("");
    setDone("Team note saved — the whole team can see it.");
  };
  const logCall = () => {
    const t = text.trim();
    if (!t) return;
    sendMessage({ customerId, channel: "call", body: t, jobId: null, estimateId: null });
    setText("");
    setDone("Call logged in this customer's messages.");
  };

  if (notes.length === 0 && !canEdit) return null;

  return (
    <section className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-sky-900">
        Team notes — everyone on the team sees these
      </p>
      {notes.length === 0 ? (
        <p className="text-sm text-slate-600">No team notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((n) => (
            <li key={n.id} className="rounded-lg bg-white px-3 py-2 text-sm shadow-sm">
              <p className="whitespace-pre-wrap text-slate-800">{n.text}</p>
              <p className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                <span>
                  {n.author} · {fmtDateTime(n.createdAt)}
                </span>
                {canEdit && (isAdmin || n.author === viewerName) && (
                  <button
                    onClick={() => {
                      if (window.confirm("Delete this team note for everyone?")) deletePrivateNote(n.id);
                    }}
                    className="min-h-11 px-2 font-semibold text-red-700 hover:underline"
                  >
                    Delete
                  </button>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
      {notes.length > SHOWN && (
        <button onClick={() => setShowAll(!showAll)} className="text-sm font-semibold text-sky-900 underline">
          {showAll ? "Show fewer" : `Show all ${notes.length}`}
        </button>
      )}
      {canEdit && (
        <>
          <textarea
            className={inputCls()}
            rows={2}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDone(null);
            }}
            placeholder="e.g. Called — wants Tuesday, gate code 1234"
            aria-label="Team note or call notes"
          />
          <div className="flex flex-wrap gap-2">
            <button onClick={addNote} disabled={!text.trim()} className={`${primaryBtn()} min-h-11`}>
              Add team note
            </button>
            <button onClick={logCall} disabled={!text.trim()} className={`${secondaryBtn()} min-h-11`}>
              Log a call
            </button>
          </div>
        </>
      )}
      {done && <p className="text-sm font-semibold text-emerald-800">{done}</p>}
    </section>
  );
}
