import type { CrewMember, Equipment } from "../types";
import {
  crewEquipmentSummary,
  toggleId,
  withCounts,
  withCrewToggled,
  type EstimateCrewPick,
} from "../estimateCrew";
import { labelCls } from "./ui";

type Value = EstimateCrewPick & {
  expectedCrew?: number | null;
  equipmentIds?: string[] | null;
};

const chip = (on: boolean) =>
  `min-h-[44px] rounded-full border px-4 text-sm font-semibold transition-colors disabled:opacity-60 ${
    on
      ? "border-emerald-700 bg-emerald-700 text-white"
      : "border-slate-300 bg-white text-slate-800 hover:border-emerald-600"
  }`;

const stepBtn =
  "flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-xl font-bold text-slate-800 hover:border-emerald-600 disabled:opacity-40";

function Stepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-sm font-semibold text-slate-800">{label}</span>
      <button
        type="button"
        className={stepBtn}
        aria-label={`Fewer ${label.toLowerCase()}`}
        disabled={value <= 0}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="w-8 text-center text-lg font-bold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className={stepBtn}
        aria-label={`More ${label.toLowerCase()}`}
        disabled={value >= 50}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </div>
  );
}

/**
 * The estimate's internal crew and equipment: steppers for a generic
 * crew ("1 climber, 2 groundsmen"), or tap the people by name, and tap
 * the equipment the job needs. Never shown to the customer.
 */
export default function CrewAndEquipment({
  value,
  crew,
  allCrew,
  equipment,
  allEquipment,
  onChange,
}: {
  value: Value;
  /** Field crew to offer. */
  crew: CrewMember[];
  /** Everyone, so a picked person who has since left still shows. */
  allCrew: CrewMember[];
  /** Equipment to offer (not retired). */
  equipment: Equipment[];
  allEquipment: Equipment[];
  onChange: (patch: Partial<Value>) => void;
}) {
  const climbers = value.expectedClimbers ?? 0;
  const groundsmen = value.expectedGroundsmen ?? 0;
  const picked = value.expectedCrewIds ?? [];
  const pickedEq = value.equipmentIds ?? [];
  const people = [
    ...crew,
    ...allCrew.filter((c) => picked.includes(c.id) && !crew.some((x) => x.id === c.id)),
  ];
  const fleet = [
    ...equipment,
    ...allEquipment.filter((e) => pickedEq.includes(e.id) && !equipment.some((x) => x.id === e.id)),
  ];
  const summary = crewEquipmentSummary(value, allCrew, allEquipment);
  // An estimate from before the steppers: just a number of people.
  const oldNumberOnly =
    value.expectedCrew != null &&
    value.expectedClimbers == null &&
    value.expectedGroundsmen == null &&
    picked.length === 0;

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 p-4">
      <p className="text-sm font-bold text-slate-900">
        Crew and equipment — internal, never shown to the customer
      </p>
      <div>
        <span className={labelCls()}>Expected crew</span>
        <div className="space-y-2">
          <Stepper
            label="Climbers"
            value={climbers}
            onChange={(n) => onChange(withCounts(value, n, groundsmen))}
          />
          <Stepper
            label="Groundsmen"
            value={groundsmen}
            onChange={(n) => onChange(withCounts(value, climbers, n))}
          />
        </div>
        {oldNumberOnly && (
          <p className="mt-1 text-xs text-slate-500">
            Saved earlier as {value.expectedCrew}{" "}
            {value.expectedCrew === 1 ? "person" : "people"}. Tap the steppers
            or names to change it.
          </p>
        )}
      </div>
      {people.length > 0 && (
        <div>
          <span className={labelCls()}>Or tap the people by name</span>
          <div className="flex flex-wrap gap-2">
            {people.map((c) => {
              const on = picked.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  className={chip(on)}
                  onClick={() => onChange(withCrewToggled(value, c.id))}
                >
                  {c.name}
                  {c.role ? <span className="font-normal opacity-80"> · {c.role}</span> : null}
                </button>
              );
            })}
          </div>
          {picked.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Names count instead of the steppers. They go on the job when it is
              scheduled, unless they are off or unavailable that day.
            </p>
          )}
        </div>
      )}
      <div>
        <span className={labelCls()}>Equipment needed</span>
        {fleet.length === 0 ? (
          <p className="text-sm text-slate-500">No equipment on the Equipment page yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {fleet.map((e) => {
              const on = pickedEq.includes(e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  aria-pressed={on}
                  className={chip(on)}
                  onClick={() => onChange({ equipmentIds: toggleId(value.equipmentIds, e.id) })}
                >
                  {e.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-sm text-slate-700">
        {summary || "No crew or equipment set yet."}
      </p>
      <p className="text-xs text-slate-500">
        The crew suggestion uses these numbers for the job and never suggests
        more people than this. The equipment is put on the job when it is
        made from this estimate.
      </p>
    </div>
  );
}
