import { useState } from "react";
import { useStore } from "../store";
import { isSchedulable } from "../crewSuggest";
import { SKILL_GROUPS, newSkillId, skillCatalog, skillsByGroup } from "../skills";
import type { CrewMember, SkillDef } from "../types";
import { skillSuggestions, type SkillSuggestion } from "../skillSuggest";
import { todayStr } from "../utils";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * The whole team's skills on one screen (owners and managers): people
 * in rows, skills in columns, one checkbox per cell. Each tap saves at
 * once. The skill list itself is edited below the grid: add, rename,
 * move to another group, or remove a skill.
 */
export default function SkillsGrid({ onClose }: { onClose: () => void }) {
  const { state, saveCrewMember, saveSkillCatalog, dismissSkillSuggestions } = useStore();
  const [editing, setEditing] = useState(false);
  if (!state) return null;
  const catalog = skillCatalog(state);
  const groups = skillsByGroup(catalog);
  const people = state.crew
    .filter((c) => c.status !== "pending" && c.status !== "revoked" && isSchedulable(c))
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggle = (m: CrewMember, patch: Partial<CrewMember>) =>
    saveCrewMember({ ...m, ...patch });
  const toggleSkill = (m: CrewMember, id: string) => {
    const has = (m.skills ?? []).includes(id);
    toggle(m, {
      skills: has ? (m.skills ?? []).filter((x) => x !== id) : [...(m.skills ?? []), id],
    });
  };

  const cell = "border-b border-slate-200 px-2 py-1.5 text-center";
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-900">Skills grid</h2>
        <div className="flex gap-2">
          <button onClick={() => setEditing((v) => !v)} className={secondaryBtn()}>
            {editing ? "Done editing the list" : "Add or change skills"}
          </button>
          <button onClick={onClose} className={secondaryBtn()}>
            Close
          </button>
        </div>
      </div>
      <p className="text-sm text-slate-600">
        Tick what each person can do; every tap saves. The scheduler
        uses these to send the right people to each job, and only lets
        someone drive when both driving boxes are ticked.
      </p>

      <SuggestionsPanel
        suggestions={skillSuggestions(state, todayStr())}
        onAccept={(list) => {
          // One save per person, with every accepted skill at once.
          const byPerson = new Map<string, SkillSuggestion[]>();
          for (const sg of list) byPerson.set(sg.crewId, [...(byPerson.get(sg.crewId) ?? []), sg]);
          for (const [crewId, items] of byPerson) {
            const m = state.crew.find((c) => c.id === crewId);
            if (!m) continue;
            const skills = new Set(m.skills ?? []);
            let driver = false;
            for (const sg of items) {
              if (sg.skillId === "driving") driver = true;
              else skills.add(sg.skillId);
            }
            saveCrewMember({
              ...m,
              skills: [...skills],
              ...(driver ? { driverLicensed: true, companyInsured: true } : {}),
            });
          }
        }}
        onDismiss={(list) => dismissSkillSuggestions(list.map((x) => x.key))}
      />

      {editing && <SkillListEditor catalog={catalog} people={people} onSave={saveSkillCatalog} />}

      <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200">
        <table className="border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th
                rowSpan={2}
                className="sticky left-0 top-0 z-30 border-b border-r border-slate-200 bg-white px-3 py-2 text-left font-bold text-slate-900"
              >
                Person
              </th>
              <th
                colSpan={3}
                className="sticky top-0 z-20 border-b border-l border-slate-200 bg-emerald-50 px-2 py-1 text-xs font-bold uppercase tracking-wide text-emerald-900"
              >
                Driving
              </th>
              {groups.map((g) => (
                <th
                  key={g.group}
                  colSpan={g.skills.length}
                  className="sticky top-0 z-20 border-b border-l border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold uppercase tracking-wide text-slate-600"
                >
                  {g.group}
                </th>
              ))}
            </tr>
            <tr>
              {["Licence", "On insurance", "CDL"].map((h, i) => (
                <th
                  key={h}
                  className={`sticky top-[29px] z-20 border-b border-slate-200 bg-white px-2 py-1 align-bottom text-xs font-semibold text-slate-700 ${i === 0 ? "border-l" : ""}`}
                >
                  {h}
                </th>
              ))}
              {groups.flatMap((g) =>
                g.skills.map((sk, i) => (
                  <th
                    key={sk.id}
                    className={`sticky top-[29px] z-20 min-w-[5.5rem] max-w-[7rem] border-b border-slate-200 bg-white px-2 py-1 align-bottom text-xs font-semibold leading-tight text-slate-700 ${i === 0 ? "border-l" : ""}`}
                  >
                    {sk.label}
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {people.map((m) => (
              <tr key={m.id} className="hover:bg-slate-50">
                <th
                  scope="row"
                  className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-slate-200 bg-white px-3 py-1.5 text-left font-semibold text-slate-900"
                >
                  {m.name}
                  <span className="block text-xs font-normal text-slate-500">{m.role}</span>
                </th>
                <td className={`${cell} border-l`}>
                  <input
                    type="checkbox"
                    aria-label={`${m.name}: has a driver's licence`}
                    checked={m.driverLicensed === true}
                    onChange={(e) => toggle(m, { driverLicensed: e.target.checked })}
                    className="h-4 w-4 accent-emerald-700"
                  />
                </td>
                <td className={cell}>
                  <input
                    type="checkbox"
                    aria-label={`${m.name}: on the company insurance`}
                    checked={m.companyInsured === true}
                    onChange={(e) => toggle(m, { companyInsured: e.target.checked })}
                    className="h-4 w-4 accent-emerald-700"
                  />
                </td>
                <td className={cell}>
                  <select
                    aria-label={`${m.name}: CDL`}
                    value={m.cdlClass ?? "none"}
                    onChange={(e) => toggle(m, { cdlClass: e.target.value as "none" | "B" | "A" })}
                    className="rounded border border-slate-300 bg-white px-1 py-0.5 text-xs"
                  >
                    <option value="none">None</option>
                    <option value="B">B</option>
                    <option value="A">A</option>
                  </select>
                </td>
                {groups.flatMap((g) =>
                  g.skills.map((sk, i) => (
                    <td key={sk.id} className={`${cell} ${i === 0 ? "border-l" : ""}`}>
                      <input
                        type="checkbox"
                        aria-label={`${m.name}: ${sk.label}`}
                        checked={(m.skills ?? []).includes(sk.id)}
                        onChange={() => toggleSkill(m, sk.id)}
                        className="h-4 w-4 accent-emerald-700"
                      />
                    </td>
                  )),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {people.length === 0 && (
        <p className="text-sm text-slate-500">No one on the team yet.</p>
      )}
    </section>
  );
}

/** Add, rename, regroup or remove skills. Changes save when "Save the list" is tapped. */
function SkillListEditor({
  catalog,
  people,
  onSave,
}: {
  catalog: SkillDef[];
  people: CrewMember[];
  onSave: (catalog: SkillDef[]) => void;
}) {
  const [draft, setDraft] = useState<SkillDef[]>(catalog);
  const [newLabel, setNewLabel] = useState("");
  const [newGroup, setNewGroup] = useState<string>("Other");
  const holders = (id: string) => people.filter((p) => (p.skills ?? []).includes(id)).length;
  const changed = JSON.stringify(draft) !== JSON.stringify(catalog);

  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    setDraft([...draft, { id: newSkillId(label, draft), label, group: newGroup }]);
    setNewLabel("");
  };
  const remove = (sk: SkillDef) => {
    const n = holders(sk.id);
    if (
      n > 0 &&
      !window.confirm(
        `Remove "${sk.label}"? ${n} ${n === 1 ? "person has" : "people have"} it ticked; it will be unticked for them.`,
      )
    ) {
      return;
    }
    setDraft(draft.filter((x) => x.id !== sk.id));
  };
  const update = (id: string, patch: Partial<SkillDef>) =>
    setDraft(draft.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm text-slate-700">
        Rename a skill by typing over it, move it to another group, or
        remove it. New skills become a new column in the grid.
      </p>
      <ul className="space-y-1.5">
        {draft.map((sk) => (
          <li key={sk.id} className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Skill name"
              className={`${inputCls()} min-w-[12rem] flex-1`}
              value={sk.label}
              onChange={(e) => update(sk.id, { label: e.target.value })}
            />
            <select
              aria-label="Group"
              className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={sk.group}
              onChange={(e) => update(sk.id, { group: e.target.value })}
            >
              {[...new Set([...SKILL_GROUPS, sk.group])].map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <span className="w-24 text-xs text-slate-500">{holders(sk.id)} ticked</span>
            <button onClick={() => remove(sk)} className="text-sm font-semibold text-red-700 hover:underline">
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 border-t border-amber-200 pt-3">
        <div className="min-w-[12rem] flex-1">
          <label className={labelCls()}>New skill</label>
          <input
            className={inputCls()}
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
            placeholder="e.g. Bucket truck operator"
          />
        </div>
        <div>
          <label className={labelCls()}>Group</label>
          <select
            className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
          >
            {SKILL_GROUPS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <button onClick={add} disabled={!newLabel.trim()} className={secondaryBtn()}>
          Add
        </button>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onSave(draft.map((x) => ({ ...x, label: x.label.trim() || x.id })))}
          disabled={!changed}
          className={primaryBtn()}
        >
          Save the list
        </button>
        <button onClick={() => setDraft(catalog)} disabled={!changed} className={secondaryBtn()}>
          Undo changes
        </button>
      </div>
    </div>
  );
}

/** Suggested skills from past jobs: accept or dismiss each (or all). */
function SuggestionsPanel({
  suggestions,
  onAccept,
  onDismiss,
}: {
  suggestions: SkillSuggestion[];
  onAccept: (list: SkillSuggestion[]) => void;
  onDismiss: (list: SkillSuggestion[]) => void;
}) {
  const [open, setOpen] = useState(true);
  if (suggestions.length === 0) return null;
  const safe = suggestions.filter((x) => !x.caution);
  return (
    <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-emerald-900">
          💡 Suggested from past jobs ({suggestions.length})
        </p>
        <div className="flex gap-2">
          {open && safe.length > 1 && (
            <button onClick={() => onAccept(safe)} className={secondaryBtn()}>
              Accept all {safe.length} skills
            </button>
          )}
          <button onClick={() => setOpen((v) => !v)} className={secondaryBtn()}>
            {open ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {open && (
        <>
          <p className="text-xs text-slate-600">
            Based on each person&apos;s job role and the jobs they have
            worked. Nothing changes until you accept. Licences are never
            in &quot;accept all&quot;: check those one by one.
          </p>
          <ul className="divide-y divide-emerald-100">
            {suggestions.map((sg) => (
              <li key={sg.key} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 text-sm text-slate-800">
                  <span className="font-semibold">{sg.personName}</span>: {sg.skillLabel}
                  <span className="text-slate-500"> · {sg.reason}</span>
                  {sg.caution && (
                    <span className="block text-xs font-semibold text-amber-700">{sg.caution}</span>
                  )}
                </span>
                <span className="flex gap-2">
                  <button
                    onClick={() => onAccept([sg])}
                    className="rounded-lg bg-emerald-700 px-3 py-1 text-xs font-semibold text-white"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => onDismiss([sg])}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700"
                  >
                    Dismiss
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
