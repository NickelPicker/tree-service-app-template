/**
 * Crew Rules page (owner-only). The rules that drive the automatic
 * crew buildout: each rule names the crew a job needs when its
 * condition matches. The suggestion takes the most crew any matching
 * rule asks for, then caps at the estimator's expected crew for the job.
 *
 * Conditions:
 * - Prune class: the job's ANSI prune class is this value.
 * - Trees (2+): the job is for at least this many trees.
 * - Service type: the job's service type is this value.
 * - Keyword: the job's title or notes contain this word ("wires",
 *   "backyard") — matched case-insensitively.
 * - Jobs that day: the number of jobs on that day is exactly / at
 *   most / at least this many — e.g. "exactly 1 job that day".
 * - Job value: the job is worth at least this many dollars (shared
 *   job-value rule: invoice → estimate → manual value). A job with
 *   no value never matches.
 * - Uses equipment: the job uses this piece of equipment — e.g.
 *   chipper jobs get a bigger crew. Drivers are still assigned
 *   separately, from the suggested crew's can-drive marks.
 * - Always: applies to every job (the fallback rule).
 *
 * A rule can also say "Assign all available crew" instead of fixed
 * numbers — then a matching job gets everyone free that day
 * (the estimator's expected-crew cap still applies on top).
 *
 * Rules save with the Save button below; "Reset to built-in rules"
 * clears the owner's rules back to the defaults.
 */
import { useState } from "react";
import { useStore } from "../store";
import type { CrewRule, CrewRuleCondition, Equipment, ServiceType } from "../types";
import { crewRulesInForce, defaultCrewRules } from "../crewSuggest";
import { uid } from "../utils";
import { isOwnerLike } from "../permissions";
import {
  dangerBtn,
  inputCls,
  labelCls,
  primaryBtn,
  secondaryBtn,
} from "./ui";

const CONDITION_KINDS: Array<{ kind: CrewRuleCondition["kind"]; label: string }> = [
  { kind: "always", label: "Always (every job)" },
  { kind: "pruneClass", label: "Prune class" },
  { kind: "minTrees", label: "Trees (at least)" },
  { kind: "serviceType", label: "Service type" },
  { kind: "keyword", label: "Keyword in title/notes" },
  { kind: "dayJobs", label: "Jobs that day" },
  { kind: "minValue", label: "Job value (at least $)" },
  { kind: "equipment", label: "Uses equipment" },
];

function conditionLabel(
  c: CrewRuleCondition,
  eqName?: (id: string) => string,
): string {
  switch (c.kind) {
    case "always":
      return "every job";
    case "pruneClass":
      return `prune class ${c.value}`;
    case "minTrees":
      return `${c.value}+ trees`;
    case "serviceType":
      return c.value;
    case "keyword":
      return `title/notes contain "${c.value}"`;
    case "dayJobs":
      return `${c.operator ?? "exactly"} ${c.count ?? 1} job${(c.count ?? 1) === 1 ? "" : "s"} that day`;
    case "minValue":
      return `the job is worth $${c.value.toLocaleString("en-US")}+`;
    case "equipment":
      return `uses the ${eqName ? eqName(c.value) : c.value}`;
  }
}

function RuleRow({
  rule,
  equipment,
  onChange,
  onDelete,
}: {
  rule: CrewRule;
  equipment: Equipment[];
  onChange: (r: CrewRule) => void;
  onDelete: () => void;
}) {
  const c = rule.condition;
  const eqName = (id: string) =>
    equipment.find((e) => e.id === id)?.name ?? id;
  const setCondition = (kind: CrewRuleCondition["kind"]) => {
    const next: CrewRuleCondition =
      kind === "always"
        ? { kind: "always" }
        : kind === "pruneClass"
          ? { kind: "pruneClass", value: "2" }
          : kind === "minTrees"
            ? { kind: "minTrees", value: 2 }
            : kind === "serviceType"
              ? { kind: "serviceType", value: "Trimming" }
              : kind === "dayJobs"
                ? { kind: "dayJobs", operator: "exactly", count: 1 }
                : kind === "minValue"
                  ? { kind: "minValue", value: 5000 }
                  : kind === "equipment"
                    ? { kind: "equipment", value: equipment[0]?.id ?? "" }
                    : { kind: "keyword", value: "wires" };
    onChange({ ...rule, condition: next });
  };
  return (
    <li className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm font-semibold"
          value={rule.name}
          onChange={(e) => onChange({ ...rule, name: e.target.value })}
          placeholder="Rule name"
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={rule.enabled !== false}
            onChange={(e) =>
              onChange({ ...rule, enabled: e.target.checked })
            }
            className="h-4 w-4 accent-emerald-700"
          />
          On
        </label>
        <button
          onClick={() => {
            if (window.confirm(`Delete the rule "${rule.name}"?`)) onDelete();
          }}
          className={dangerBtn()}
        >
          Delete
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className={labelCls()}>When</label>
          <select
            className={inputCls()}
            value={c.kind}
            onChange={(e) =>
              setCondition(e.target.value as CrewRuleCondition["kind"])
            }
          >
            {CONDITION_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        {c.kind === "pruneClass" && (
          <div>
            <label className={labelCls()}>Prune class</label>
            <select
              className={inputCls()}
              value={c.value}
              onChange={(e) =>
                onChange({
                  ...rule,
                  condition: {
                    kind: "pruneClass",
                    value: e.target.value as "1" | "2" | "3" | "4",
                  },
                })
              }
            >
              <option value="1">Class I — Fine</option>
              <option value="2">Class II — Standard</option>
              <option value="3">Class III — Hazard</option>
              <option value="4">Class IV — Crown reduction</option>
            </select>
          </div>
        )}
        {c.kind === "minTrees" && (
          <div>
            <label className={labelCls()}>At least this many trees</label>
            <input
              type="number"
              min={1}
              className={inputCls()}
              value={c.value}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({
                  ...rule,
                  condition: {
                    kind: "minTrees",
                    value: isNaN(n) || n < 1 ? 1 : n,
                  },
                });
              }}
            />
          </div>
        )}
        {c.kind === "serviceType" && (
          <div>
            <label className={labelCls()}>Service type</label>
            <select
              className={inputCls()}
              value={c.value}
              onChange={(e) =>
                onChange({
                  ...rule,
                  condition: {
                    kind: "serviceType",
                    value: e.target.value as ServiceType,
                  },
                })
              }
            >
              {(
                [
                  "Trimming",
                  "Removal",
                  "Stump Grinding",
                  "Plant Health Care",
                  "Emergency",
                  "Fertilization",
                ] as ServiceType[]
              ).map(
                (s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ),
              )}
            </select>
          </div>
        )}
        {c.kind === "keyword" && (
          <div>
            <label className={labelCls()}>Keyword</label>
            <input
              className={inputCls()}
              value={c.value}
              onChange={(e) =>
                onChange({
                  ...rule,
                  condition: { kind: "keyword", value: e.target.value },
                })
              }
              placeholder="e.g. wires"
            />
          </div>
        )}
        {c.kind === "dayJobs" && (
          <>
            <div>
              <label className={labelCls()}>Comparison</label>
              <select
                className={inputCls()}
                value={c.operator ?? "exactly"}
                onChange={(e) =>
                  onChange({
                    ...rule,
                    condition: {
                      kind: "dayJobs",
                      operator: e.target.value as
                        | "exactly"
                        | "at most"
                        | "at least",
                      count: c.count ?? 1,
                    },
                  })
                }
              >
                <option value="exactly">Exactly</option>
                <option value="at most">At most</option>
                <option value="at least">At least</option>
              </select>
            </div>
            <div>
              <label className={labelCls()}>Jobs on that day</label>
              <input
                type="number"
                min={1}
                className={inputCls()}
                value={c.count ?? 1}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  onChange({
                    ...rule,
                    condition: {
                      kind: "dayJobs",
                      operator: c.operator ?? "exactly",
                      count: isNaN(n) || n < 1 ? 1 : n,
                    },
                  });
                }}
              />
            </div>
          </>
        )}
        {c.kind === "minValue" && (
          <div>
            <label className={labelCls()}>Job worth at least ($)</label>
            <input
              type="number"
              min={0}
              step={100}
              className={inputCls()}
              value={c.value}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({
                  ...rule,
                  condition: {
                    kind: "minValue",
                    value: isNaN(n) || n < 0 ? 0 : n,
                  },
                });
              }}
            />
          </div>
        )}
        {c.kind === "equipment" && (
          <div>
            <label className={labelCls()}>Equipment</label>
            {equipment.length === 0 ? (
              <p className="text-sm text-slate-500">
                No equipment in the app yet — add some on the Equipment
                page first.
              </p>
            ) : (
              <select
                className={inputCls()}
                value={c.value}
                onChange={(e) =>
                  onChange({
                    ...rule,
                    condition: { kind: "equipment", value: e.target.value },
                  })
                }
              >
                {equipment.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
      <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          checked={rule.allAvailable === true}
          onChange={(e) =>
            onChange({ ...rule, allAvailable: e.target.checked })
          }
          className="h-4 w-4 accent-emerald-700"
        />
        Assign all available crew
      </label>
      {rule.allAvailable ? (
        <p className="text-sm text-slate-600">
          When {conditionLabel(c, eqName)}: everyone free that day goes
          on the job (never more than the estimator&apos;s expected crew for it).
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls()}>Climbers needed</label>
            <input
              type="number"
              min={0}
              className={inputCls()}
              value={rule.climbers}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({ ...rule, climbers: isNaN(n) || n < 0 ? 0 : n });
              }}
            />
          </div>
          <div>
            <label className={labelCls()}>Groundsmen needed</label>
            <input
              type="number"
              min={0}
              className={inputCls()}
              value={rule.groundsmen}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                onChange({ ...rule, groundsmen: isNaN(n) || n < 0 ? 0 : n });
              }}
            />
          </div>
        </div>
      )}
      <p className="text-xs text-slate-500">
        When {conditionLabel(c, eqName)}:{" "}
        {rule.allAvailable
          ? "everyone available that day."
          : `${rule.climbers} climber${rule.climbers === 1 ? "" : "s"} + ${rule.groundsmen} grounds${rule.groundsmen === 1 ? "man" : "men"}.`}
      </p>
    </li>
  );
}

export default function CrewRules() {
  const { state, role, setCalendarSettings } = useStore();
  const [rules, setRules] = useState<CrewRule[] | null>(null);
  const [saved, setSaved] = useState(false);
  if (!state) return null;
  if (!isOwnerLike(role)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Crew rules</h1>
        <p className="text-sm text-slate-600">
          Only managers can view and change the crew-suggestion rules.
        </p>
      </div>
    );
  }
  const current = rules ?? crewRulesInForce(state);
  const dirty = rules !== null;
  const save = () => {
    setCalendarSettings({ crewRules: current });
    setRules(null);
    setSaved(true);
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-900">Crew rules</h1>
      <p className="text-sm text-slate-600">
        These rules drive the automatic crew buildout. When a job is
        suggested a crew, the app takes the most crew any matching rule
        asks for — then caps it at the number the estimator put on the estimate,
        and splits the team across the day&apos;s jobs by value. A rule
        can also say &ldquo;Assign all available crew&rdquo; instead of
        fixed numbers, and a rule can look at the whole day — e.g.
        &ldquo;exactly 1 job that day&rdquo; puts everyone on that one
        job. Add rules as you learn what each kind of job takes; the
        more rules, the smarter the suggestions.
      </p>
      {saved && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Rules saved.
        </p>
      )}
      <ul className="space-y-2">
        {current.map((r) => (
          <RuleRow
            key={r.id}
            rule={r}
            equipment={state.equipment}
            onChange={(next) => {
              setSaved(false);
              setRules(current.map((x) => (x.id === r.id ? next : x)));
            }}
            onDelete={() => {
              setSaved(false);
              setRules(current.filter((x) => x.id !== r.id));
            }}
          />
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => {
            setSaved(false);
            setRules([
              ...current,
              {
                id: uid(),
                name: "New rule",
                condition: { kind: "always" },
                climbers: 1,
                groundsmen: 1,
                enabled: true,
              },
            ]);
          }}
          className={secondaryBtn()}
        >
          + Add a rule
        </button>
        <button
          onClick={save}
          disabled={!dirty}
          className={primaryBtn()}
        >
          Save crew rules
        </button>
        <button
          onClick={() => {
            if (
              window.confirm(
                "Reset to the built-in rules? Your saved rules will be replaced.",
              )
            ) {
              setCalendarSettings({ crewRules: defaultCrewRules() });
              setRules(null);
              setSaved(true);
            }
          }}
          className={secondaryBtn()}
        >
          Reset to built-in rules
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Built-in rules: every job 1 climber + 1 groundsman; one job
        that day — everyone available on it; big job ($5,000+) —
        everyone available on it; Class II prune 1 + 1; over wires
        1 + 1; 2+ trees 2 climbers + 2 groundsmen. A rule can also
        look at the equipment on the job — e.g. chipper jobs get a
        bigger crew. The suggestion never beats the estimator&apos;s number on
        the estimate, and it never suggests someone on approved time
        off or already on another job that day.
      </p>
    </div>
  );
}
