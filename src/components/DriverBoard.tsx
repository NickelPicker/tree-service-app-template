import { useState } from "react";
import type { AppState, Equipment, Job } from "../types";
import {
  SLOT_LABEL,
  assignDrive,
  bookedElsewhere,
  driveProblem,
  removeDrive,
  slotOf,
  suggestDrivers,
  usable,
  type DriveSlot,
} from "../driverSuggest";
import { isLegalDriver } from "../skills";

/**
 * "Who's driving what": drag equipment onto the people on this job (or
 * tap a piece, then tap a person, on a phone). Each person holds one
 * truck, one thing behind it, and one thing on the trailer; dropping a
 * new one replaces what was in that spot.
 */
export default function DriverBoard({
  state,
  form,
  canEdit,
  onChange,
}: {
  state: AppState;
  form: Job;
  canEdit: boolean;
  onChange: (patch: { equipmentIds: string[]; equipmentDrivers: Record<string, string> | null }) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);

  const crew = form.crewIds
    .map((id) => state.crew.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const ids = form.equipmentIds ?? [];
  // Drivers only count while they are on the job.
  const drivers = Object.fromEntries(
    Object.entries(form.equipmentDrivers ?? {}).filter(([eq, c]) => form.crewIds.includes(c) && ids.includes(eq)),
  );
  const byId = new Map(state.equipment.map((e) => [e.id, e]));
  const busy = bookedElsewhere(state, form);

  const emit = (r: { equipmentIds: string[]; drivers: Record<string, string> }) =>
    onChange({
      equipmentIds: r.equipmentIds,
      equipmentDrivers: Object.keys(r.drivers).length > 0 ? r.drivers : null,
    });
  const drop = (crewId: string, eqId: string) => {
    if (!canEdit) return;
    emit(assignDrive(state.equipment, ids, drivers, crewId, eqId));
    setPicked(null);
  };
  const suggest = () => {
    const s = suggestDrivers(state, { ...form, equipmentDrivers: null });
    // Keep anything the suggestion didn't cover (taken but nobody drives it).
    emit({ equipmentIds: s.equipmentIds, drivers: s.drivers });
    setNotes(s.notes);
  };

  // The tray: on this job without a driver, then free equipment.
  const tray = state.equipment.filter(
    (e) => !drivers[e.id] && (ids.includes(e.id) || (usable(e) && e.status !== "retired")),
  );

  if (crew.length === 0) {
    return (
      <p className="mt-3 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500">
        Tick who&apos;s on this job above, then drag trucks and equipment onto them here.
      </p>
    );
  }

  const chip = (e: Equipment, opts: { onJob: boolean }) => {
    const elsewhere = busy.get(e.id);
    return (
      <button
        key={e.id}
        type="button"
        draggable={canEdit}
        disabled={!canEdit}
        onDragStart={(ev) => {
          ev.dataTransfer.setData("text/plain", e.id);
          ev.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => setPicked(picked === e.id ? null : e.id)}
        title={elsewhere ? `Also booked on ${elsewhere} that day` : undefined}
        className={`cursor-grab rounded-full border px-2.5 py-1 text-xs font-semibold ${
          picked === e.id
            ? "border-emerald-700 bg-emerald-700 text-white"
            : opts.onJob
              ? "border-amber-400 bg-amber-50 text-amber-900"
              : "border-slate-300 bg-white text-slate-800 hover:border-emerald-600"
        }`}
      >
        {e.kind === "Truck" ? "🛻" : "⛓"} {e.name}
        {opts.onJob ? " · no driver" : ""}
        {elsewhere ? " · booked elsewhere" : ""}
      </button>
    );
  };

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-slate-900">Who&apos;s driving what</p>
        {canEdit && (
          <button
            type="button"
            onClick={suggest}
            className="rounded-lg border border-emerald-700 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
          >
            ✨ Suggest who drives
          </button>
        )}
      </div>
      {notes && notes.length > 0 && (
        <div className="mt-2 space-y-0.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {notes.map((n) => (
            <p key={n}>⚠ {n}</p>
          ))}
        </div>
      )}
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {crew.map((c) => {
          const held = Object.entries(drivers)
            .filter(([, d]) => d === c.id)
            .map(([id]) => byId.get(id))
            .filter((e): e is Equipment => !!e);
          const bySlot = new Map<DriveSlot, Equipment>();
          for (const h of held) bySlot.set(slotOf(h, held.filter((o) => o !== h)), h);
          const truck = bySlot.get("truck") ?? null;
          const tow = bySlot.get("tow") ?? null;
          const problem =
            held.length > 0 ? driveProblem(state, c, truck, tow ?? bySlot.get("load") ?? null) : null;
          const nonDriver = !isLegalDriver(c);
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              aria-label={`Drop equipment on ${c.name}`}
              onDragOver={(ev) => {
                if (!canEdit) return;
                ev.preventDefault();
                setOver(c.id);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(ev) => {
                ev.preventDefault();
                setOver(null);
                const id = ev.dataTransfer.getData("text/plain");
                if (id) drop(c.id, id);
              }}
              onClick={() => picked && drop(c.id, picked)}
              onKeyDown={(ev) => {
                if ((ev.key === "Enter" || ev.key === " ") && picked) drop(c.id, picked);
              }}
              className={`rounded-lg border bg-white p-2.5 ${
                over === c.id || picked ? "border-emerald-600 ring-2 ring-emerald-200" : "border-slate-200"
              } ${problem ? "border-red-400" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: c.color }} />
                <span className="text-sm font-semibold text-slate-900">{c.name}</span>
                {nonDriver && <span className="text-xs text-slate-500">· doesn&apos;t drive</span>}
              </div>
              {held.length === 0 ? (
                <p className="mt-1 text-xs text-slate-500">
                  {nonDriver ? "Riding along." : "Drop a truck or equipment here."}
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {(["truck", "tow", "load"] as DriveSlot[]).map((slot) => {
                    const e = bySlot.get(slot);
                    if (!e) return null;
                    return (
                      <li key={slot} className="flex items-center justify-between gap-2 text-sm">
                        <span>
                          <span className="text-xs text-slate-500">{SLOT_LABEL[slot]}: </span>
                          <span
                            draggable={canEdit}
                            onDragStart={(ev) => ev.dataTransfer.setData("text/plain", e.id)}
                            className="font-semibold text-slate-900"
                          >
                            {e.name}
                          </span>
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            aria-label={`Remove ${e.name}`}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              emit(removeDrive(ids, drivers, e.id));
                            }}
                            className="rounded px-1.5 text-slate-400 hover:bg-red-50 hover:text-red-700"
                          >
                            ✕
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {problem && <p className="mt-1 text-xs font-semibold text-red-700">⚠ {problem}</p>}
            </div>
          );
        })}
      </div>
      {canEdit && (
        <>
          <p className="mt-3 text-xs font-semibold text-slate-600">
            Drag onto a person (on a phone: tap one, then tap the person)
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {tray.length === 0 ? (
              <span className="text-xs text-slate-500">All equipment is out.</span>
            ) : (
              tray.map((e) => chip(e, { onJob: ids.includes(e.id) }))
            )}
          </div>
        </>
      )}
    </div>
  );
}
