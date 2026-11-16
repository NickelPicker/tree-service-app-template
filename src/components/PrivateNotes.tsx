import { useState } from "react";
import { useStore } from "../store";
import type { PrivateNoteKind } from "../types";
import { isOwnerLike } from "../permissions";
import { fmtDateTime, uid } from "../utils";
import { inputCls, secondaryBtn } from "./ui";

/**
 * Admin-only notes (owners and managers) and "My private notes" (only
 * the author sees them) on a customer. The shared Team note lives in
 * TeamNotes.tsx and is shown first on the customer page.
 */
export default function PrivateNotesSection({ customerId }: { customerId: string }) {
  const {
    state,
    role,
    canEdit,
    viewer,
    viewerName,
    addPrivateNote,
    deletePrivateNote,
  } = useStore();
  const [adminText, setAdminText] = useState("");
  const [personalText, setPersonalText] = useState("");
  if (!state) return null;

  // Visibility rules: admin notes only for the Owner (admin) viewer;
  // personal notes only for their author. The viewer picker is the
  // stand-in for the viewer, so author = viewer identity.
  const adminNotes = state.notes.filter(
    (n) => n.customerId === customerId && n.kind === "admin",
  );
  const myNotes = state.notes.filter(
    (n) =>
      n.customerId === customerId &&
      n.kind === "personal" &&
      n.author === viewerName,
  );
  // Editors (admins and office climbers/sales) can delete notes, and a
  // Climber or Sales on a crew login can delete their own personal
  // notes (the database lets the author do that). Groundsmen cannot
  // delete — but they can still add their own personal notes below,
  // which is the one record-editing exception for them.
  const deletesOwnNotes =
    viewer?.role === "Climber" || viewer?.role === "Sales";
  const canDelete = (author: string) =>
    canEdit || (deletesOwnNotes && author === viewerName);

  const add = (kind: PrivateNoteKind, text: string, clear: () => void) => {
    const t = text.trim();
    if (!t) return;
    addPrivateNote({
      id: uid(),
      customerId,
      kind,
      author: viewerName,
      createdAt: new Date().toISOString(),
      text: t,
    });
    clear();
  };

  const noteList = (
    notes: typeof adminNotes,
    empty: string,
  ) =>
    notes.length === 0 ? (
      <p className="text-sm text-slate-500">{empty}</p>
    ) : (
      <ul className="space-y-2">
        {notes.map((n) => (
          <li
            key={n.id}
            className="rounded-lg bg-slate-50 px-3 py-2 text-sm"
          >
            <p className="text-slate-800">{n.text}</p>
            <p className="mt-1 flex items-center justify-between text-xs text-slate-500">
              <span>
                {n.author} · {fmtDateTime(n.createdAt)}
              </span>
              {canDelete(n.author) && (
                <button
                  onClick={() => deletePrivateNote(n.id)}
                  className="font-semibold text-red-700 hover:underline"
                >
                  Delete
                </button>
              )}
            </p>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      {isOwnerLike(role) && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Admin-only notes (only managers see these)
          </p>
          {noteList(adminNotes, "No admin-only notes yet.")}
          <textarea
            className={`${inputCls()} mt-2`}
            rows={2}
            value={adminText}
            onChange={(e) => setAdminText(e.target.value)}
            placeholder="Admin-only note — never visible to office or crew…"
          />
          <button
            onClick={() => add("admin", adminText, () => setAdminText(""))}
            disabled={!adminText.trim()}
            className={`${secondaryBtn()} mt-2`}
          >
            Add admin-only note
          </button>
        </div>
      )}
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          My private notes (only you see these)
        </p>
        {noteList(myNotes, "No private notes yet.")}
        <textarea
          className={`${inputCls()} mt-2`}
          rows={2}
          value={personalText}
          onChange={(e) => setPersonalText(e.target.value)}
          placeholder="A note only you can see…"
        />
        <button
          onClick={() =>
            add("personal", personalText, () => setPersonalText(""))
          }
          disabled={!personalText.trim()}
          className={`${secondaryBtn()} mt-2`}
        >
          Add my private note
        </button>
      </div>
    </div>
  );
}

