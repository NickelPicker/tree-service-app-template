import { useState } from "react";
import {
  MAP_APPS,
  directionsUrl,
  getMapApp,
  hasDestination,
  setMapApp,
  type Destination,
  type MapApp,
} from "../navigation";

/**
 * "Navigate" to a job in the person's map app. The first tap asks which
 * map app to use (remembered on this phone). A job that isn't assigned
 * to the person asks first: crew may need to head to another job
 * mid-day, so it is never blocked, just confirmed.
 */
export default function NavigateButton({
  destination,
  assigned,
  label = "🧭 Navigate",
  className,
}: {
  destination: Destination;
  /** False for a job the person is not on: asks "are you sure?" first. */
  assigned: boolean;
  label?: string;
  className?: string;
}) {
  const [choosing, setChoosing] = useState(false);
  if (!hasDestination(destination)) return null;

  const go = (app: MapApp) => {
    window.open(directionsUrl(app, destination), "_blank", "noopener");
  };
  const start = () => {
    if (
      !assigned &&
      !window.confirm(
        "This job isn't assigned to you. Are you sure you want to navigate to this address?",
      )
    ) {
      return;
    }
    const app = getMapApp();
    if (app) go(app);
    else setChoosing(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={start}
        className={
          className ??
          "rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
        }
      >
        {label}
      </button>
      {choosing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
          role="dialog"
          aria-modal="true"
          aria-label="Choose your map app"
          onClick={() => setChoosing(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-lg font-bold text-slate-900">Which map app do you use?</p>
            <p className="mt-1 text-sm text-slate-600">
              We&apos;ll use it every time you tap Navigate. You can change it later on your
              profile.
            </p>
            <div className="mt-4 space-y-2">
              {MAP_APPS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setMapApp(a.id);
                    setChoosing(false);
                    go(a.id);
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-left text-base font-semibold text-slate-900 hover:border-emerald-600"
                >
                  {a.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setChoosing(false)}
              className="mt-3 w-full text-sm font-semibold text-slate-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** The map-app choice, for the person's profile. */
export function MapAppSetting() {
  const [app, setApp] = useState<MapApp | null>(() => getMapApp());
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500" htmlFor="map-app">
        Map app for directions
      </label>
      <select
        id="map-app"
        value={app ?? ""}
        onChange={(e) => {
          const v = (e.target.value || null) as MapApp | null;
          setMapApp(v);
          setApp(v);
        }}
        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
      >
        <option value="">Ask me next time</option>
        {MAP_APPS.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-slate-500">Saved on this phone.</p>
    </div>
  );
}
