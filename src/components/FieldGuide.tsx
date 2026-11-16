import { useEffect, useState } from "react";
import {
  CUTTING_BASICS,
  DENVER_ZONE,
  PRUNE_CLASSES,
  formatMonths,
  formatSpeciesWhere,
  speciesInUse,
  type SpeciesGuide,
  type SpeciesInUse,
} from "../treeGuide";
import { useStore } from "../store";
import { inputCls, labelCls } from "./ui";

/**
 * Field Guide — the in-app tree knowledge base. Everything the crew
 * needs in the field: per-species biology, when to prune and when not
 * to, what each prune class means, how to make the cut, and what
 * diseases to look for. All text lives in src/treeGuide.ts — the app
 * never pulls the text from another page or the internet. Photos are
 * the one exception: they hotlink to CSU Extension and need internet,
 * like the map tiles.
 */
/** Small thumbnail that opens a full-size zoom view on tap. */
export function ZoomablePhoto({
  src,
  alt,
  credit,
  size = "md",
}: {
  src: string;
  alt: string;
  credit?: string;
  size?: "sm" | "md";
}) {
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);
  const cls = size === "sm" ? "h-16 w-16" : "h-28 w-28";
  return (
    <>
      <button
        onClick={() => setZoomed(true)}
        className="shrink-0"
        title={`Zoom in — ${alt}`}
      >
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          loading="lazy"
          className={`${cls} rounded-lg border border-slate-200 object-cover`}
        />
      </button>
      {zoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setZoomed(false)}
        >
          <figure
            className="max-h-full max-w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={src}
              alt={alt}
              referrerPolicy="no-referrer"
              className="max-h-[80vh] max-w-full rounded-lg object-contain"
            />
            <figcaption className="mt-2 text-center text-sm text-white">
              {alt}
              {credit ? ` — Photo: ${credit}` : ""}
            </figcaption>
            <button
              onClick={() => setZoomed(false)}
              className="mx-auto mt-3 block rounded-full bg-white px-4 py-1 text-sm font-bold text-slate-900"
            >
              Close ✕
            </button>
          </figure>
        </div>
      )}
    </>
  );
}

export function SpeciesPhoto({
  guide,
  size = "md",
}: {
  guide: SpeciesGuide;
  size?: "sm" | "md";
}) {
  if (!guide.photoUrl) return null;
  return (
    <ZoomablePhoto
      src={guide.photoUrl}
      alt={`${guide.name} — ${guide.botanical}`}
      credit={guide.photoCredit}
      size={size}
    />
  );
}

export default function FieldGuide() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  // The list is the 16 curated reference entries PLUS every other
  // species that shows up in the team's actual work (customer trees,
  // jobs' trees, estimate lines) — a new tree in an estimate lands
  // here on its own, as a basic entry until its details are added.
  const entries = speciesInUse(state);
  const matches = entries.filter(
    (e) =>
      q === "" ||
      e.name.toLowerCase().includes(q) ||
      (e.botanical ?? "").toLowerCase().includes(q) ||
      formatSpeciesWhere(e).toLowerCase().includes(q),
  );
  const selected =
    entries.find((e) => e.key === selectedKey) ?? matches[0] ?? null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900">Field Guide</h1>
        <p className="text-sm text-slate-600">
          Denver sits in {DENVER_ZONE}. Cold winters, hot dry summers, and
          a short spring — that is why timing matters as much as technique.
          The day briefing on the Today page flags the same windows for
          the trees on each job. The list below covers every tree we work
          with: the reference entries plus any other species in our trees,
          jobs, or estimates.
        </p>
      </div>

      {/* Species browser */}
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <label className={labelCls()}>Find a species</label>
          <input
            className={inputCls()}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. silver maple, ash, locust"
          />
          <ul className="mt-2 space-y-1">
            {matches.length === 0 && (
              <li className="px-2 py-1 text-sm text-slate-500">
                No species matches &ldquo;{query}&rdquo; yet.
              </li>
            )}
            {matches.map((e) => (
              <li key={e.key}>
                <button
                  onClick={() => setSelectedKey(e.key)}
                  className={`w-full rounded-lg px-2 py-1.5 text-left text-sm ${
                    selected?.key === e.key
                      ? "bg-emerald-700 font-semibold text-white"
                      : "text-slate-800 hover:bg-slate-100"
                  }`}
                >
                  {e.name}
                  {e.guide ? (
                    <span
                      className={`block text-xs italic ${
                        selected?.key === e.key
                          ? "text-emerald-100"
                          : "text-slate-500"
                      }`}
                    >
                      {e.botanical}
                    </span>
                  ) : (
                    <>
                      <span className="mt-0.5 block">
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                          Guide details not filled in yet
                        </span>
                      </span>
                      <span
                        className={`block text-xs ${
                          selected?.key === e.key
                            ? "text-emerald-100"
                            : "text-slate-500"
                        }`}
                      >
                        {formatSpeciesWhere(e)}
                      </span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          {selected ? (
            selected.guide ? (
              <SpeciesDetail guide={selected.guide} />
            ) : (
              <BasicSpeciesDetail entry={selected} />
            )
          ) : (
            <p className="text-sm text-slate-500">
              Pick a species on the left to see its guide.
            </p>
          )}
        </div>
      </div>

      {/* Prune classes */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-slate-900">
          Prune classes (ANSI A300)
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          A prune class is the scope of the job — it tells the crew what
          to cut and, just as important, what to leave alone. Set the
          class on the job and the day briefing shows the definition.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {PRUNE_CLASSES.map((c) => (
            <div
              key={c.id}
              className="rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <p className="font-bold text-slate-900">{c.name}</p>
              <p className="mt-1 text-sm text-slate-700">{c.definition}</p>
              <p className="mt-1 text-sm text-slate-600">
                <span className="font-semibold">Typical use: </span>
                {c.typicalUse}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Cutting basics */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-base font-bold text-slate-900">
          Cutting basics — the rules that never change
        </h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-slate-700">
          {CUTTING_BASICS.map((rule, i) => (
            <li key={i}>
              <span className="font-semibold">{rule.title} — </span>
              {rule.body}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/**
 * A species found in the team's work (customer trees, jobs, estimates)
 * that has no curated guide entry yet. It lists where it shows up and
 * says plainly that its details are not on file — it never invents
 * prune windows, biology, or disease notes.
 */
function BasicSpeciesDetail({ entry }: { entry: SpeciesInUse }) {
  const where = formatSpeciesWhere(entry);
  return (
    <div>
      <h2 className="text-lg font-bold text-slate-900">{entry.name}</h2>
      <p className="mt-1">
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
          Guide details not filled in yet
        </span>
      </p>
      {where && (
        <p className="mt-2 text-sm text-slate-600">
          <span className="font-semibold">Where it shows up: </span>
          {where}
        </p>
      )}
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        This tree shows up in our work but doesn&apos;t have a field guide
        entry yet — no prune windows, biology, or disease notes on file.
        Ask the office to add them.
      </p>
    </div>
  );
}

function SpeciesDetail({ guide }: { guide: SpeciesGuide }) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <SpeciesPhoto guide={guide} />
        <div>
          <h2 className="text-lg font-bold text-slate-900">{guide.name}</h2>
          <p className="text-sm italic text-slate-500">{guide.botanical}</p>
          <p className="mt-1 text-sm text-slate-600">
            Hardiness {guide.zones} · Mature size {guide.size}
          </p>
          {guide.photoUrl && guide.photoCredit && (
            <p className="mt-1 text-xs text-slate-400">
              Photo: {guide.photoCredit}
            </p>
          )}
        </div>
      </div>

      <h3 className="mt-4 text-sm font-bold uppercase tracking-wide text-slate-500">
        Know this tree
      </h3>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
        {guide.biology.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>

      <h3 className="mt-4 text-sm font-bold uppercase tracking-wide text-slate-500">
        When to prune
      </h3>
      <div className="mt-1 space-y-1 text-sm">
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
          <span className="font-bold">
            Best: {formatMonths(guide.bestMonths)} —{" "}
          </span>
          {guide.bestWhy}
        </p>
        <p className="rounded-lg bg-red-50 px-3 py-2 text-red-900">
          <span className="font-bold">
            Avoid: {formatMonths(guide.avoidMonths)} —{" "}
          </span>
          {guide.avoidWhy}
        </p>
      </div>

      <h3 className="mt-4 text-sm font-bold uppercase tracking-wide text-slate-500">
        What a Class II prune means here
      </h3>
      <p className="mt-1 text-sm text-slate-700">{guide.classNote}</p>

      <h3 className="mt-4 text-sm font-bold uppercase tracking-wide text-slate-500">
        How to cut it
      </h3>
      <p className="mt-1 text-sm text-slate-700">{guide.cutNotes}</p>

      <h3 className="mt-4 text-sm font-bold uppercase tracking-wide text-slate-500">
        Diseases to look for
      </h3>
      <ul className="mt-1 space-y-2">
        {guide.diseases.map((d) => (
          <li
            key={d.name}
            className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"
          >
            <div className="flex items-start gap-3">
              {d.photoUrl && (
                <ZoomablePhoto
                  src={d.photoUrl}
                  alt={d.name}
                  credit={d.photoCredit}
                  size="sm"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-bold text-slate-900">{d.name}</p>
                <p className="mt-0.5 text-slate-700">
                  <span className="font-semibold">Spot it: </span>
                  {d.signs}
                </p>
                <p className="mt-0.5 text-slate-700">
                  <span className="font-semibold">Do: </span>
                  {d.action}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
