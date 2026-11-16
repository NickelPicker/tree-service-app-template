import { useStore } from "../store";
import { OFFLINE_SAVED_TEXT, saveBannerKind, useFieldQueue } from "../fieldQueue";

/**
 * The banner at the top of the app after a save did not reach the
 * database (review, #8). A field tap (clock in/out, Arrived,
 * Done) made without signal is kept on the phone and sends by itself, so
 * it gets a calm amber note, not the red "did NOT save". Red is for real
 * failures, and for changes that are not kept on the phone.
 */
export default function SaveBanner() {
  const { saveStatus, saveError, retrySave, clearSaveError, unsavedNonField } = useStore();
  const queue = useFieldQueue();
  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const kind = saveBannerKind(saveStatus, saveError, queue, online, unsavedNonField);
  if (kind === "none") return null;
  if (kind === "offline-saved") {
    return (
      <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-3">
        <p className="mx-auto max-w-7xl text-base font-semibold text-amber-900">📶 {OFFLINE_SAVED_TEXT}</p>
      </div>
    );
  }
  return (
    <div className="border-b border-red-300 bg-red-50 px-4 py-3">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-red-800">
          {kind === "offline-unsaved" ? (
            <>
              📶 No signal: your last change has NOT saved yet. Keep the app open and press Retry when you have
              signal, or it will be lost on refresh.
            </>
          ) : (
            <>⚠ Your last change did NOT save — it will disappear on refresh. {saveError}</>
          )}
        </p>
        <div className="flex gap-2">
          <button
            onClick={retrySave}
            className="min-h-11 rounded-lg bg-red-700 px-3 py-1.5 text-sm font-semibold text-white"
          >
            Retry save
          </button>
          <button
            onClick={() => {
              if (window.confirm("Throw away the change that did not save and load the saved data again?")) clearSaveError();
            }}
            className="min-h-11 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-semibold text-red-700"
          >
            Discard change and reload
          </button>
        </div>
      </div>
    </div>
  );
}
