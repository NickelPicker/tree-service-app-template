import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Equipment, EquipmentProblem } from "../types";
import {
  PROBLEM_NOTE_MAX,
  myProblems,
  problemNoteProblem,
  problemStatusLabel,
  unresolvedFor,
} from "../equipmentProblems";
import { loadProblemPhoto, preparePhoto } from "../data/problemPhotos";
import { showFlash } from "../flash";
import { fmtDateTime } from "../utils";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * Equipment "Problem" button (the "equipment problems" rules). Anyone on the
 * team reports a problem with a short text and an optional photo; the
 * office sees open reports on the Dashboard to-do and the Equipment
 * page, and marks them fixed or sends the machine to the shop.
 */

/** The report form: which machine (when there is a choice), what is wrong, an optional photo. */
export function ProblemReportForm({
  equipment,
  defaultEquipmentId,
  onDone,
}: {
  /** Machines to choose from; one = no picker. */
  equipment: Equipment[];
  defaultEquipmentId?: string;
  onDone: () => void;
}) {
  const { reportEquipmentProblem } = useStore();
  const [equipmentId, setEquipmentId] = useState(defaultEquipmentId ?? equipment[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<Uint8Array | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  }, [photoUrl]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPhotoBusy(true);
    try {
      const bytes = await preparePhoto(file);
      setPhoto(bytes);
      setPhotoUrl(URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/jpeg" })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that photo.");
    } finally {
      setPhotoBusy(false);
    }
  };

  const send = async () => {
    const bad = problemNoteProblem(note);
    if (bad) {
      setError(bad);
      return;
    }
    if (!equipmentId) {
      setError("Pick the machine.");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await reportEquipmentProblem(equipmentId, note, photo);
    setBusy(false);
    if (res.error) {
      setError(`Not sent: ${res.error}`);
      return;
    }
    showFlash(
      res.photoError
        ? `Problem sent to the office, but ${res.photoError.charAt(0).toLowerCase()}${res.photoError.slice(1)}`
        : "Problem sent to the office.",
      res.photoError ? { tone: "warn" } : undefined,
    );
    onDone();
  };

  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/60 p-3">
      {equipment.length > 1 && (
        <label className="block">
          <span className={labelCls()}>Which machine?</span>
          <select
            value={equipmentId}
            onChange={(e) => setEquipmentId(e.target.value)}
            className={`${inputCls()} min-h-11`}
          >
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.kind}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block">
        <span className={labelCls()}>What&apos;s wrong?</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={PROBLEM_NOTE_MAX}
          rows={3}
          placeholder="e.g. Chipper feed roller keeps jamming"
          className={inputCls()}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={photoBusy}
          className={`${secondaryBtn()} min-h-11`}
        >
          {photoBusy ? "Reading photo…" : photo ? "📷 Change photo" : "📷 Add a photo (optional)"}
        </button>
        {photo && (
          <button
            type="button"
            onClick={() => {
              setPhoto(null);
              setPhotoUrl(null);
            }}
            className="min-h-11 text-sm font-semibold text-slate-600 underline"
          >
            Remove photo
          </button>
        )}
      </div>
      {photoUrl && <img src={photoUrl} alt="Photo to send" className="max-h-40 rounded-lg border border-slate-200" />}
      {error && <p className="text-sm font-semibold text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || photoBusy}
          className={`${primaryBtn()} min-h-11`}
        >
          {busy ? "Sending…" : "Send to the office"}
        </button>
        <button type="button" onClick={onDone} className={`${secondaryBtn()} min-h-11`}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** "📷 Photo": loads the stored photo only when tapped. */
function ProblemPhoto({ problemId }: { problemId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  if (url) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mt-1 block">
        <img src={url} alt="Problem photo" className="max-h-56 rounded-lg border border-slate-200" />
      </a>
    );
  }
  return (
    <span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          loadProblemPhoto(problemId)
            .then((b) => setUrl(URL.createObjectURL(b)))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not open the photo."))
            .finally(() => setBusy(false));
        }}
        className="text-sm font-semibold text-emerald-800 underline"
      >
        {busy ? "Opening…" : "📷 See photo"}
      </button>
      {error && <span className="ml-2 text-sm text-red-700">{error}</span>}
    </span>
  );
}

/** One report: what, who, when, its photo, and (office) Mark fixed / Send to shop. */
export function ProblemRow({
  problem,
  equipmentName,
  staff,
}: {
  problem: EquipmentProblem;
  /** Shown when the row is listed away from its machine. */
  equipmentName?: string;
  staff: boolean;
}) {
  const { resolveEquipmentProblem } = useStore();
  const [busy, setBusy] = useState(false);
  const act = (action: "fixed" | "shop") => {
    setBusy(true);
    void resolveEquipmentProblem(problem.id, action).then((err) => {
      setBusy(false);
      if (err) showFlash(`Not saved: ${err}`, { tone: "warn" });
      else showFlash(action === "fixed" ? "Marked fixed." : "Sent to the shop.");
    });
  };
  const tone =
    problem.status === "open"
      ? "bg-red-100 text-red-800"
      : problem.status === "in_shop"
        ? "bg-amber-100 text-amber-800"
        : "bg-emerald-100 text-emerald-800";
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900">
            {equipmentName && <span>{equipmentName}: </span>}
            <span className="whitespace-pre-wrap break-words font-normal text-slate-800">{problem.note}</span>
          </p>
          <p className="text-xs text-slate-500">
            {problem.reportedName || "Someone"} · {fmtDateTime(problem.createdAt)}
            {problem.statusAt && problem.status !== "open"
              ? ` · ${problemStatusLabel(problem.status).toLowerCase()} by ${problem.statusByName ?? "the office"} ${fmtDateTime(problem.statusAt)}`
              : ""}
          </p>
          {problem.hasPhoto && <ProblemPhoto problemId={problem.id} />}
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${tone}`}>
          {problemStatusLabel(problem.status)}
        </span>
      </div>
      {staff && problem.status !== "fixed" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => act("fixed")} className={`${primaryBtn()} min-h-11`}>
            Mark fixed
          </button>
          {problem.status === "open" && (
            <button type="button" disabled={busy} onClick={() => act("shop")} className={`${secondaryBtn()} min-h-11`}>
              Send to shop
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Inside one machine on the Equipment page: its open reports and the Problem button. */
export function MachineProblems({ equipment }: { equipment: Equipment }) {
  const { state, role } = useStore();
  const [reporting, setReporting] = useState(false);
  if (!state) return null;
  const staff = role !== "crew";
  const list = unresolvedFor(state.equipmentProblems, equipment.id);
  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-slate-900">
          Problems {list.length > 0 && `(${list.length} open)`}
        </p>
        {!reporting && (
          <button
            type="button"
            onClick={() => setReporting(true)}
            className="min-h-11 rounded-lg border border-red-200 px-3 py-1 text-sm font-bold text-red-700 hover:bg-red-50"
          >
            ⚠ Problem
          </button>
        )}
      </div>
      {reporting && (
        <div className="mt-2">
          <ProblemReportForm equipment={[equipment]} onDone={() => setReporting(false)} />
        </div>
      )}
      {list.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {list.map((p) => (
            <li key={p.id}>
              <ProblemRow problem={p} staff={staff} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Top of the Equipment page (office): every report still open or in the shop. */
export function OpenProblemsCard() {
  const { state, role } = useStore();
  if (!state || role === "crew") return null;
  const list = (state.equipmentProblems ?? [])
    .filter((p) => p.status !== "fixed")
    .sort((a, b) => Number(a.status !== "open") - Number(b.status !== "open") || a.createdAt.localeCompare(b.createdAt));
  if (list.length === 0) return null;
  const name = (id: string) => state.equipment.find((e) => e.id === id)?.name ?? "Equipment";
  return (
    <section className="rounded-xl border border-red-200 bg-white p-4 shadow-sm" aria-label="Equipment problems">
      <h2 className="text-base font-bold text-slate-900">Equipment problems ({list.length})</h2>
      <p className="text-sm text-slate-600">Reported by the team. Mark each one fixed, or send the machine to the shop.</p>
      <ul className="mt-2 space-y-1.5">
        {list.map((p) => (
          <li key={p.id}>
            <ProblemRow problem={p} equipmentName={name(p.equipmentId)} staff />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Crew Today screen: "⚠ Problem with equipment?" — today's machines
 * first, then the rest — plus the person's own recent reports.
 */
export function TodayProblemButton({ todayEquipmentIds }: { todayEquipmentIds: string[] }) {
  const { state, viewerId } = useStore();
  const [open, setOpen] = useState(false);
  if (!state || state.equipment.length === 0) return null;
  const usable = state.equipment.filter((e) => e.status !== "retired");
  const today = usable.filter((e) => todayEquipmentIds.includes(e.id));
  const rest = usable.filter((e) => !todayEquipmentIds.includes(e.id));
  const mine = myProblems(state.equipmentProblems, viewerId);
  const name = (id: string) => state.equipment.find((e) => e.id === id)?.name ?? "Equipment";
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      {open ? (
        <ProblemReportForm equipment={[...today, ...rest]} onDone={() => setOpen(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-12 w-full rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-base font-bold text-red-800 hover:bg-red-100"
        >
          ⚠ Problem with a machine?
        </button>
      )}
      {mine.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-bold text-slate-900">Your reports</p>
          <ul className="mt-1 space-y-1.5">
            {mine.map((p) => (
              <li key={p.id}>
                <ProblemRow problem={p} equipmentName={name(p.equipmentId)} staff={false} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
