import { clearFlash, useFlash } from "../flash";

/** The confirmation line from src/flash.ts, shown once at the App level. */
export default function FlashBar() {
  const flash = useFlash();
  if (!flash) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4"
    >
      <div
        className={`flex max-w-xl flex-wrap items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold shadow-2xl ${
          flash.tone === "ok" ? "bg-emerald-800 text-white" : "bg-amber-100 text-amber-950"
        }`}
      >
        <span className="min-w-0 flex-1">{flash.text}</span>
        {flash.actions.map((a) => (
          <button
            key={a.label}
            onClick={() => {
              clearFlash();
              a.run();
            }}
            className="min-h-11 rounded-lg bg-white/15 px-3 py-2 underline hover:bg-white/25"
          >
            {a.label}
          </button>
        ))}
        <button
          onClick={clearFlash}
          aria-label="Close"
          className="min-h-11 min-w-11 rounded-lg px-2 text-lg hover:bg-white/20"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
