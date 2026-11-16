import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useStore } from "../store";
import type { RiskRating, Tree, TreeCondition } from "../types";
import { fmtDate, todayStr, uid } from "../utils";
import {
  DENVER_TREEKEEPER_URL,
  findNearbyPublicTrees,
  type PublicRecordTree,
} from "../data/publicRecordTrees";
import {
  dangerBtn,
  inputCls,
  labelCls,
  primaryBtn,
  secondaryBtn,
} from "./ui";

/**
 * tree map for one customer: satellite imagery with a
 * toggleable nationwide parcel-boundary overlay, hand-drawn property
 * boundaries, and labeled tree dots backed by a tree inventory.
 *
 * Network use (all user-initiated, documented in README):
 * - Esri World Imagery tiles (satellite base, free, no key)
 * - Regrid nationwide parcel-boundary tiles via ArcGIS Living Atlas
 *   (free tile layer; the service only caches zooms 15–17, so the
 *   overlay scales its zoom-17 tiles when zoomed further in)
 * - Nominatim geocoding (free, no key) for "Locate property"
 * Everything else in the app keeps working with no connection.
 */

const DENVER_CENTER: [number, number] = [39.7392, -104.9903];
const SAT_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const PARCEL_URL =
  "https://tiles.arcgis.com/tiles/KzeiCaQsMoeCfoCq/arcgis/rest/services/Regrid_Nationwide_Parcel_Boundaries_v1/MapServer/tile/{z}/{y}/{x}";

const CONDITION_COLORS: Record<TreeCondition, string> = {
  Good: "#16a34a",
  Fair: "#d97706",
  Poor: "#ea580c",
  Dead: "#64748b",
};

const CONDITIONS: TreeCondition[] = ["Good", "Fair", "Poor", "Dead"];

type Mode = "view" | "addTree" | "drawBoundary" | "movePin";

function treeDotHtml(tree: Tree, selected: boolean, draft: boolean): string {
  const color = CONDITION_COLORS[tree.condition];
  const dot = draft
    ? `width:18px;height:18px;border-radius:9999px;background:#ffffff;border:2px dashed ${color};box-shadow:0 1px 4px rgba(0,0,0,0.35);`
    : `width:18px;height:18px;border-radius:9999px;background:${color};border:2px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.45);${selected ? "outline:3px solid #f59e0b;outline-offset:1px;" : ""}`;
  return (
    `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">` +
    `<span style="background:rgba(255,255,255,0.95);border:1px solid #cbd5e1;border-radius:9999px;padding:0 6px;font-size:11px;font-weight:700;color:#0f172a;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.25);">${tree.label}</span>` +
    `<span style="${dot}"></span>` +
    `</div>`
  );
}

function vertexHtml(): string {
  return `<div style="width:14px;height:14px;background:#ffffff;border:2px solid #059669;border-radius:3px;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>`;
}

function centerPinHtml(): string {
  return (
    `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">` +
    `<span style="background:rgba(255,255,255,0.95);border:1px solid #cbd5e1;border-radius:9999px;padding:0 6px;font-size:11px;font-weight:700;color:#0f172a;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.25);">Property</span>` +
    `<span style="width:18px;height:18px;border-radius:9999px;background:#2563eb;border:2px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.45);"></span>` +
    `</div>`
  );
}

function jobPinHtml(title: string): string {
  return (
    `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">` +
    `<span style="background:rgba(255,255,255,0.95);border:1px solid #cbd5e1;border-radius:9999px;padding:0 6px;font-size:11px;font-weight:700;color:#0f172a;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.25);">${title}</span>` +
    `<span style="width:18px;height:18px;border-radius:9999px;background:#dc2626;border:2px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:800;">📍</span>` +
    `</div>`
  );
}

function nextTreeLabel(trees: Tree[]): string {
  let max = 0;
  for (const t of trees) {
    const m = /^Tree (\d+)$/.exec(t.label);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Tree ${max + 1}`;
}

export default function TreeMap({ customerId }: { customerId: string }) {
  const { state, canEdit, saveCustomer, saveTree, deleteTree, openJob } =
    useStore();
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const treeLayerRef = useRef<L.LayerGroup | null>(null);
  const boundaryLayerRef = useRef<L.LayerGroup | null>(null);
  const centerLayerRef = useRef<L.LayerGroup | null>(null);
  const parcelLayerRef = useRef<L.TileLayer | null>(null);
  const jobPinLayerRef = useRef<L.LayerGroup | null>(null);

  const [mode, setMode] = useState<Mode>("view");
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [editingTree, setEditingTree] = useState<Tree | null>(null);
  const [boundaryDraft, setBoundaryDraft] = useState<Array<[number, number]>>([]);
  const [parcelLines, setParcelLines] = useState(true);
  const [parcelError, setParcelError] = useState(false);
  const [satError, setSatError] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locateMsg, setLocateMsg] = useState("");
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");
  const [manualMsg, setManualMsg] = useState("");
  // Public-record import (TreeKeeper / Denver open data, preview sample).
  const [nearbyPublic, setNearbyPublic] = useState<
    Array<PublicRecordTree & { distanceMiles: number }> | null
  >(null);
  const [importMsg, setImportMsg] = useState("");
  const [importing, setImporting] = useState(false);
  // Draft inputs for the tree history editors.
  const [newDbh, setNewDbh] = useState("");
  const [newConditionNotes, setNewConditionNotes] = useState("");

  const customer = state?.customers.find((c) => c.id === customerId) ?? null;
  const trees = (state?.trees ?? []).filter((t) => t.customerId === customerId);
  const pinnedJobs = (state?.jobs ?? []).filter(
    (j) => j.customerId === customerId && j.lat !== null && j.lng !== null,
  );

  // Refs so the once-registered map handlers always see fresh values.
  const modeRef = useRef<Mode>(mode);
  const customerRef = useRef(customer);
  const treesRef = useRef(trees);
  useEffect(() => {
    modeRef.current = mode;
    customerRef.current = customer;
    treesRef.current = trees;
  });

  const hasCoords = customer?.mapLat !== null && customer?.mapLng !== null;

  // --- Map creation (once per customer; the parent keys by customer id) ---
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const c = customerRef.current;
    const located = c !== null && c.mapLat !== null && c.mapLng !== null;
    const center: [number, number] = located
      ? [c.mapLat as number, c.mapLng as number]
      : DENVER_CENTER;
    const map = L.map(mapEl.current, { zoomControl: true }).setView(
      center,
      located ? 19 : 12,
    );
    const sat = L.tileLayer(SAT_URL, {
      attribution:
        "Imagery © Esri, Maxar, Earthstar Geographics",
      maxZoom: 19,
    });
    sat.on("tileerror", () => setSatError(true));
    sat.addTo(map);
    const parcels = L.tileLayer(PARCEL_URL, {
      attribution: "Parcel lines © Regrid via ArcGIS Living Atlas",
      minZoom: 15,
      maxZoom: 19,
      maxNativeZoom: 17,
      opacity: 0.95,
    });
    parcels.on("tileerror", () => setParcelError(true));
    parcels.addTo(map);
    parcelLayerRef.current = parcels;
    treeLayerRef.current = L.layerGroup().addTo(map);
    boundaryLayerRef.current = L.layerGroup().addTo(map);
    centerLayerRef.current = L.layerGroup().addTo(map);
    jobPinLayerRef.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      const m = modeRef.current;
      const cust = customerRef.current;
      if (!cust) return;
      if (m === "addTree") {
        setEditingTree({
          id: uid(),
          customerId: cust.id,
          lat: e.latlng.lat,
          lng: e.latlng.lng,
          label: nextTreeLabel(treesRef.current),
          species: "",
          dbh: "",
          height: "",
          condition: "Good",
          status: "",
          notes: "",
          dbhHistory: [],
          conditionHistory: [],
          riskRating: "",
          riskNotes: "",
          photos: [],
          nextInspectionDate: null,
          source: "manual",
          siteId: null,
        });
        setSelectedTreeId(null);
        setMode("view");
      } else if (m === "drawBoundary") {
        setBoundaryDraft((d) => [...d, [e.latlng.lat, e.latlng.lng]]);
      } else if (m === "movePin") {
        saveCustomer({
          ...cust,
          mapLat: e.latlng.lat,
          mapLng: e.latlng.lng,
        });
        setMode("view");
        setLocateMsg("Property pin moved to the clicked point.");
      }
    });

    mapRef.current = map;
    const raf = requestAnimationFrame(() => map.invalidateSize());
    const timer = window.setTimeout(() => map.invalidateSize(), 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
    // Mount-only: the parent remounts per customer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Parcel overlay toggle ---
  useEffect(() => {
    const map = mapRef.current;
    const layer = parcelLayerRef.current;
    if (!map || !layer) return;
    if (parcelLines) layer.addTo(map);
    else map.removeLayer(layer);
  }, [parcelLines]);

  // --- Tree dots ---
  useEffect(() => {
    const group = treeLayerRef.current;
    const map = mapRef.current;
    if (!group || !map) return;
    group.clearLayers();
    const shown = [...trees];
    const draftIsNew =
      editingTree && !trees.some((t) => t.id === editingTree.id);
    if (draftIsNew && editingTree) shown.push(editingTree);
    for (const t of shown) {
      const isDraft = draftIsNew && t.id === editingTree?.id;
      const marker = L.marker([t.lat, t.lng], {
        icon: L.divIcon({
          className: "",
          html: treeDotHtml(t, t.id === selectedTreeId, !!isDraft),
          iconSize: [120, 40],
          iconAnchor: [60, 30],
        }),
        draggable: canEdit && !isDraft,
        title: t.label,
      });
      marker.on("click", () => {
        setSelectedTreeId(t.id);
        if (!isDraft) setEditingTree(t);
      });
      if (canEdit && !isDraft) {
        marker.on("dragend", () => {
          const ll = marker.getLatLng();
          saveTree({ ...t, lat: ll.lat, lng: ll.lng });
        });
      }
      marker.addTo(group);
    }
  }, [trees, selectedTreeId, editingTree, canEdit, saveTree]);

  // --- Property boundary (saved polygon, or draft while drawing) ---
  useEffect(() => {
    const group = boundaryLayerRef.current;
    if (!group || !customer) return;
    group.clearLayers();
    if (mode === "drawBoundary") {
      if (boundaryDraft.length >= 2) {
        const shape =
          boundaryDraft.length >= 3
            ? L.polygon(boundaryDraft, {
                color: "#059669",
                weight: 2,
                fillColor: "#10b981",
                fillOpacity: 0.15,
              })
            : L.polyline(boundaryDraft, { color: "#059669", weight: 2 });
        shape.addTo(group);
      }
      boundaryDraft.forEach(([lat, lng], i) => {
        const v = L.marker([lat, lng], {
          icon: L.divIcon({
            className: "",
            html: vertexHtml(),
            iconSize: [14, 14],
            iconAnchor: [7, 7],
          }),
          draggable: true,
          title: `Boundary point ${i + 1} (drag to adjust)`,
        });
        v.on("dragend", () => {
          const ll = v.getLatLng();
          setBoundaryDraft((d) =>
            d.map((p, j) => (j === i ? [ll.lat, ll.lng] : p)),
          );
        });
        v.addTo(group);
      });
    } else if (customer.boundary && customer.boundary.length >= 3) {
      L.polygon(customer.boundary, {
        color: "#059669",
        weight: 2,
        fillColor: "#10b981",
        fillOpacity: 0.15,
      }).addTo(group);
    }
  }, [mode, boundaryDraft, customer]);

  // --- Property center pin (draggable for editors) ---
  useEffect(() => {
    const group = centerLayerRef.current;
    if (!group || !customer) return;
    group.clearLayers();
    if (customer.mapLat === null || customer.mapLng === null) return;
    const pin = L.marker([customer.mapLat, customer.mapLng], {
      icon: L.divIcon({
        className: "",
        html: centerPinHtml(),
        iconSize: [120, 40],
        iconAnchor: [60, 30],
      }),
      draggable: canEdit,
      title: "Property pin (drag to move)",
    });
    if (canEdit) {
      pin.on("dragend", () => {
        const ll = pin.getLatLng();
        saveCustomer({ ...customer, mapLat: ll.lat, mapLng: ll.lng });
      });
    }
    pin.addTo(group);
  }, [customer, canEdit, saveCustomer]);

  // --- Drop-a-pin job locations (red pins; click opens the job) ---
  useEffect(() => {
    const group = jobPinLayerRef.current;
    if (!group) return;
    group.clearLayers();
    for (const j of pinnedJobs) {
      if (j.lat === null || j.lng === null) continue;
      const marker = L.marker([j.lat, j.lng], {
        icon: L.divIcon({
          className: "",
          html: jobPinHtml("Job pin"),
          iconSize: [120, 40],
          iconAnchor: [60, 30],
        }),
        title: `${j.title} (job pin — click to open)`,
      });
      marker.on("click", () => openJob(j.id));
      marker.addTo(group);
    }
  }, [pinnedJobs, openJob]);

  if (!state || !customer) return null;

  const locateProperty = async () => {
    setLocating(true);
    setLocateMsg("");
    try {
      const q = [customer.address, customer.city, customer.zip]
        .filter(Boolean)
        .join(", ");
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: Array<{ lat: string; lon: string }> = await res.json();
      if (data.length === 0) {
        setLocateMsg(
          "Couldn't find that address. Click “Place pin” and tap the map, or enter coordinates below.",
        );
        return;
      }
      const lat = parseFloat(data[0].lat);
      const lng = parseFloat(data[0].lon);
      saveCustomer({ ...customer, mapLat: lat, mapLng: lng });
      mapRef.current?.setView([lat, lng], 19);
      setLocateMsg("Property located — check the pin, and drag it if it's off.");
    } catch {
      setLocateMsg(
        "Locate failed (no connection or lookup error). Place the pin by hand instead.",
      );
    } finally {
      setLocating(false);
    }
  };

  const centerOnManual = () => {
    const lat = parseFloat(manualLat);
    const lng = parseFloat(manualLng);
    if (
      Number.isNaN(lat) ||
      Number.isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      setManualMsg("Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
      return;
    }
    saveCustomer({ ...customer, mapLat: lat, mapLng: lng });
    mapRef.current?.setView([lat, lng], 19);
    setManualMsg("Property pin set to those coordinates.");
  };

  /**
   * Import from the public record (TreeKeeper / Denver open data).
   * There is no public TreeKeeper API, so the preview matches a
   * built-in sample of Denver public-record trees near the property's
   * coordinates (see publicRecordTrees.ts) — it never invents a live
   * lookup. Imported trees are marked source "Denver public record"
   * with their city site ID, and the team verifies them on site.
   */
  const searchPublicRecord = () => {
    if (!customer) return;
    if (customer.mapLat === null || customer.mapLng === null) {
      setImportMsg(
        "Locate the property first (\"Locate property\" or place the pin) — the public-record search needs coordinates.",
      );
      setNearbyPublic(null);
      return;
    }
    setImporting(true);
    const found = findNearbyPublicTrees(customer.mapLat, customer.mapLng, 0.5);
    setNearbyPublic(found);
    setImporting(false);
    setImportMsg(
      found.length === 0
        ? "No public-record trees in the preview sample within half a mile of this property. Check the Denver TreeKeeper map (link below) for the live inventory."
        : `${found.length} public-record tree${found.length === 1 ? "" : "s"} in the preview sample within half a mile. Import the ones that belong to this property.`,
    );
  };

  const importPublicTree = (t: PublicRecordTree & { distanceMiles: number }) => {
    if (!customer) return;
    // Skip if this site ID is already in the inventory.
    if (trees.some((x) => x.siteId === t.siteId)) {
      setImportMsg(`${t.siteId} is already in this property's inventory.`);
      return;
    }
    saveTree({
      id: uid(),
      customerId: customer.id,
      lat: t.lat,
      lng: t.lng,
      label: nextTreeLabel(trees),
      species: t.species,
      dbh: `${t.dbhInches} in`,
      height: `${t.heightFeet} ft`,
      condition: "Fair",
      status: "Public record — verify on site",
      notes: `Imported from the Denver public tree inventory (${t.area}, ${t.distanceMiles.toFixed(2)} mi away). Condition and size are from the public record — verify on site before quoting work.`,
      dbhHistory: [{ date: todayStr(), dbh: `${t.dbhInches} in` }],
      conditionHistory: [],
      riskRating: "",
      riskNotes: "",
      photos: [],
      nextInspectionDate: null,
      source: "Denver public record",
      siteId: t.siteId,
    });
    setImportMsg(`${t.species} (${t.siteId}) added to the inventory as a public-record tree.`);
  };

  const finishBoundary = () => {
    if (boundaryDraft.length < 3) {
      setLocateMsg("A boundary needs at least 3 points — click the map to add more.");
      return;
    }
    saveCustomer({ ...customer, boundary: boundaryDraft });
    setMode("view");
    setLocateMsg("Boundary saved.");
  };

  const openTreeFromList = (t: Tree) => {
    setSelectedTreeId(t.id);
    setEditingTree(t);
    const map = mapRef.current;
    if (map) map.setView([t.lat, t.lng], Math.max(map.getZoom(), 18));
  };

  const form = editingTree;
  const setForm = (patch: Partial<Tree>) =>
    setEditingTree((p) => (p ? { ...p, ...patch } : p));

  /**
   * Downscale a phone photo to a small JPEG data URL (max 1024 px on the
   * long edge) so field photos stay light in the database. Full-size
   * phone photos are megabytes each; these land around 100–200 KB.
   */
  const downscalePhoto = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx2d = canvas.getContext("2d");
        if (!ctx2d) {
          URL.revokeObjectURL(url);
          reject(new Error("Canvas not available"));
          return;
        }
        ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that photo"));
      };
      img.src = url;
    });

  const addPhotos = async (files: FileList | null) => {
    if (!files || !form) return;
    const remaining = Math.max(0, 5 - (form.photos ?? []).length);
    const picked = Array.from(files).slice(0, remaining);
    if (picked.length === 0) return;
    const urls: string[] = [];
    for (const f of picked) {
      try {
        urls.push(await downscalePhoto(f));
      } catch {
        // Skip unreadable files; the rest still upload.
      }
    }
    if (urls.length > 0)
      setForm({ photos: [...(form.photos ?? []), ...urls] });
  };
  const canSaveForm =
    form !== null && form.label.trim() !== "" && form.customerId === customer.id;

  // Per-tree work history: jobs linked to this tree
  // plus estimates whose line items name it.
  const formJobs = form
    ? (state?.jobs ?? []).filter((j) => (j.treeIds ?? []).includes(form.id))
    : [];
  const formEstimates = form
    ? (state?.estimates ?? []).filter((e) =>
        e.lines.some((l) => l.treeId === form.id),
      )
    : [];

  const addDbhMeasurement = () => {
    if (!form || newDbh.trim() === "") return;
    const entry = { date: todayStr(), dbh: newDbh.trim() };
    setForm({
      dbhHistory: [...(form.dbhHistory ?? []), entry],
      dbh: newDbh.trim(),
    });
    setNewDbh("");
  };

  const addConditionRecord = () => {
    if (!form) return;
    const entry = {
      date: todayStr(),
      condition: form.condition,
      notes: newConditionNotes.trim(),
    };
    setForm({
      conditionHistory: [...(form.conditionHistory ?? []), entry],
    });
    setNewConditionNotes("");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canEdit && (
          <>
            <button
              onClick={() => {
                setEditingTree(null);
                setSelectedTreeId(null);
                setMode(mode === "addTree" ? "view" : "addTree");
              }}
              className={primaryBtn()}
            >
              {mode === "addTree" ? "Cancel adding tree" : "+ Add tree"}
            </button>
            <button
              onClick={() => {
                setEditingTree(null);
                if (mode === "drawBoundary") {
                  setMode("view");
                } else {
                  setBoundaryDraft(customer.boundary ?? []);
                  setMode("drawBoundary");
                }
              }}
              className={secondaryBtn()}
            >
              {mode === "drawBoundary" ? "Cancel drawing" : "Draw boundary"}
            </button>
            <button
              onClick={locateProperty}
              disabled={locating}
              className={secondaryBtn()}
            >
              {locating ? "Locating…" : "Locate property"}
            </button>
            <button
              onClick={() => setMode(mode === "movePin" ? "view" : "movePin")}
              className={secondaryBtn()}
            >
              {mode === "movePin" ? "Cancel placing pin" : "Place pin"}
            </button>
          </>
        )}
        <label className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700">
          <input
            type="checkbox"
            checked={parcelLines}
            onChange={(e) => setParcelLines(e.target.checked)}
          />
          Property lines
        </label>
      </div>

      {mode === "addTree" && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Click the map where the tree is — a form opens to fill in its
          details.
        </p>
      )}
      {mode === "drawBoundary" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          <span>
            Click the map to add boundary points ({boundaryDraft.length} so
            far). Drag a corner to adjust it.
          </span>
          <button onClick={finishBoundary} className={primaryBtn()}>
            Finish boundary
          </button>
          <button
            onClick={() => setBoundaryDraft([])}
            className={secondaryBtn()}
          >
            Clear points
          </button>
        </div>
      )}
      {mode === "movePin" && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Click the map where the property is — the pin moves there. You
          can also drag the blue pin any time.
        </p>
      )}
      {locateMsg && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {locateMsg}
        </p>
      )}

      <div
        ref={mapEl}
        className="h-[420px] w-full overflow-hidden rounded-xl border border-slate-200 shadow-sm"
      />
      <p className="text-xs text-slate-500">
        Satellite imagery and property lines load from the internet — the
        rest of the app keeps working offline. Property lines come from
        Regrid&apos;s free nationwide parcel tile layer (shown at zooms
        15–17 and scaled in closer); they are a visual guide, not a
        survey. Your saved boundary is the polygon you draw.
      </p>
      {satError && (
        <p className="text-xs font-semibold text-red-700">
          Satellite imagery failed to load — check the connection and try
          again.
        </p>
      )}
      {parcelError && (
        <p className="text-xs font-semibold text-red-700">
          Property lines failed to load for this area — the satellite view
          and your drawn boundary still work.
        </p>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div>
            <label className={labelCls()}>Latitude</label>
            <input
              className={inputCls()}
              value={manualLat}
              onChange={(e) => setManualLat(e.target.value)}
              placeholder={hasCoords ? String(customer.mapLat) : "39.6658"}
            />
          </div>
          <div>
            <label className={labelCls()}>Longitude</label>
            <input
              className={inputCls()}
              value={manualLng}
              onChange={(e) => setManualLng(e.target.value)}
              placeholder={hasCoords ? String(customer.mapLng) : "-104.9293"}
            />
          </div>
          <button onClick={centerOnManual} className={secondaryBtn()}>
            Center map here
          </button>
          {customer.boundary && mode !== "drawBoundary" && (
            <button
              onClick={() => {
                if (window.confirm("Remove the saved property boundary?")) {
                  saveCustomer({ ...customer, boundary: null });
                }
              }}
              className={dangerBtn()}
            >
              Remove boundary
            </button>
          )}
          {manualMsg && (
            <p className="w-full text-sm text-slate-600">{manualMsg}</p>
          )}
        </div>
      )}

      {/* Import from the public record (TreeKeeper / Denver open data) */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900">
          Import from public record
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Denver&apos;s public tree inventory (TreeKeeper) lists parkway
          and park trees by location, species, and size. Search near this
          property&apos;s coordinates and add the ones that belong here —
          they&apos;re marked{" "}
          <span className="font-semibold">Denver public record</span> with
          their city site ID, so the team knows to verify them on site.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Preview only: this searches a small built-in sample of the
          public inventory — there is no public TreeKeeper API, and no
          live lookup is faked. Full contractor access needs
          city-issued credentials.{" "}
          <a
            href={DENVER_TREEKEEPER_URL}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-emerald-700 underline"
          >
            Open Denver&apos;s public TreeKeeper map →
          </a>
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={searchPublicRecord}
            disabled={importing || !canEdit}
            className={secondaryBtn()}
          >
            {importing ? "Searching…" : "Search nearby public trees"}
          </button>
          {!canEdit && (
            <span className="text-xs text-slate-500">
              Only the office and owners can import.
            </span>
          )}
        </div>
        {importMsg && (
          <p className="mt-2 text-sm text-slate-600">{importMsg}</p>
        )}
        {nearbyPublic && nearbyPublic.length > 0 && (
          <ul className="mt-3 space-y-2">
            {nearbyPublic.map((t) => {
              const already = trees.some((x) => x.siteId === t.siteId);
              return (
                <li
                  key={t.siteId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                >
                  <span className="text-sm text-slate-800">
                    <span className="font-semibold">{t.species}</span> —{" "}
                    {t.dbhInches} in DBH, {t.heightFeet} ft · {t.area} ·{" "}
                    {t.distanceMiles.toFixed(2)} mi · site {t.siteId}
                  </span>
                  <button
                    onClick={() => importPublicTree(t)}
                    disabled={!canEdit || already}
                    className={secondaryBtn()}
                  >
                    {already ? "Already imported" : "Import"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {form && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-base font-bold text-slate-900">
            {trees.some((t) => t.id === form.id)
              ? `Edit ${form.label}`
              : "New tree"}
          </h3>
          <p className="mb-3 text-sm text-slate-500">
            Position: {form.lat.toFixed(6)}, {form.lng.toFixed(6)} — drag
            the dot on the map to move it.
          </p>
          {form.source === "Denver public record" && (
            <p className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
              Imported from the Denver public record — site ID{" "}
              <span className="font-semibold">{form.siteId ?? "—"}</span>.
              Verify species and size on site before quoting work.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls()}>Label *</label>
              <input
                className={inputCls()}
                value={form.label}
                disabled={!canEdit}
                onChange={(e) => setForm({ label: e.target.value })}
              />
            </div>
            <div>
              <label className={labelCls()}>Species</label>
              <input
                className={inputCls()}
                value={form.species}
                disabled={!canEdit}
                onChange={(e) => setForm({ species: e.target.value })}
                placeholder="e.g. Green ash"
              />
            </div>
            <div>
              <label className={labelCls()}>DBH (diameter)</label>
              <input
                className={inputCls()}
                value={form.dbh}
                disabled={!canEdit}
                onChange={(e) => setForm({ dbh: e.target.value })}
                placeholder='e.g. 18 in'
              />
            </div>
            <div>
              <label className={labelCls()}>Height</label>
              <input
                className={inputCls()}
                value={form.height}
                disabled={!canEdit}
                onChange={(e) => setForm({ height: e.target.value })}
                placeholder="e.g. 35 ft"
              />
            </div>
            <div>
              <label className={labelCls()}>Condition</label>
              <select
                className={inputCls()}
                value={form.condition}
                disabled={!canEdit}
                onChange={(e) =>
                  setForm({ condition: e.target.value as TreeCondition })
                }
              >
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls()}>Work / status</label>
              <input
                className={inputCls()}
                value={form.status}
                disabled={!canEdit}
                onChange={(e) => setForm({ status: e.target.value })}
                placeholder="e.g. Prune next visit"
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls()}>Notes</label>
              <textarea
                className={inputCls()}
                rows={2}
                value={form.notes}
                disabled={!canEdit}
                onChange={(e) => setForm({ notes: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls()}>Photos</label>
              {(form.photos ?? []).length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {(form.photos ?? []).map((src, i) => (
                    <div key={`${i}-${src.slice(0, 24)}`} className="relative">
                      <img
                        src={src}
                        alt={`Tree photo ${i + 1}`}
                        className="h-20 w-20 rounded-lg border border-slate-200 object-cover"
                      />
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              photos: (form.photos ?? []).filter(
                                (_, x) => x !== i,
                              ),
                            })
                          }
                          className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white"
                          title="Remove photo"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {canEdit && (
                <>
                  <label className="inline-block cursor-pointer rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800">
                    + Add photos
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        addPhotos(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <p className="mt-1 text-xs text-slate-500">
                    Up to 5 photos per tree. Photos are shrunk on upload so
                    they stay light — they save with the tree when you tap
                    Save below.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Work history for this tree */}
          <div className="mt-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Work history for this tree
            </p>
            {formJobs.length === 0 && formEstimates.length === 0 ? (
              <p className="text-sm text-slate-500">
                No jobs or estimates linked to this tree yet — link it from
                a job or an estimate line.
              </p>
            ) : (
              <ul className="space-y-1 text-sm text-slate-800">
                {formJobs.map((j) => (
                  <li key={j.id}>
                    <button
                      onClick={() => openJob(j.id)}
                      className="font-semibold text-emerald-700 underline"
                    >
                      {j.title}
                    </button>{" "}
                    · {fmtDate(j.date)} · {j.status}
                  </li>
                ))}
                {formEstimates.map((e) => (
                  <li key={e.id}>
                    Estimate: {e.title} · {e.status}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* DBH history */}
          <div className="mt-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              DBH history
            </p>
            {(form.dbhHistory ?? []).length === 0 ? (
              <p className="text-sm text-slate-500">No measurements yet.</p>
            ) : (
              <ul className="space-y-1 text-sm text-slate-800">
                {[...(form.dbhHistory ?? [])].reverse().map((m, i) => (
                  <li key={`${m.date}-${i}`}>
                    {fmtDate(m.date)} — {m.dbh}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  className={inputCls()}
                  value={newDbh}
                  onChange={(e) => setNewDbh(e.target.value)}
                  placeholder='New measurement, e.g. 19 in'
                  style={{ maxWidth: 220 }}
                />
                <button onClick={addDbhMeasurement} className={secondaryBtn()}>
                  Add measurement
                </button>
              </div>
            )}
          </div>

          {/* Condition history */}
          <div className="mt-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Condition history
            </p>
            {(form.conditionHistory ?? []).length === 0 ? (
              <p className="text-sm text-slate-500">No condition notes yet.</p>
            ) : (
              <ul className="space-y-1 text-sm text-slate-800">
                {[...(form.conditionHistory ?? [])].reverse().map((c, i) => (
                  <li key={`${c.date}-${i}`}>
                    {fmtDate(c.date)} — {c.condition}
                    {c.notes ? ` — ${c.notes}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  className={inputCls()}
                  value={newConditionNotes}
                  onChange={(e) => setNewConditionNotes(e.target.value)}
                  placeholder="Note for today's condition (optional)"
                  style={{ maxWidth: 260 }}
                />
                <button onClick={addConditionRecord} className={secondaryBtn()}>
                  Record current condition
                </button>
              </div>
            )}
          </div>

          {/* Risk assessment */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls()}>Risk rating</label>
              <select
                className={inputCls()}
                value={form.riskRating ?? ""}
                disabled={!canEdit}
                onChange={(e) =>
                  setForm({ riskRating: (e.target.value as RiskRating | "") ?? "" })
                }
              >
                <option value="">Not assessed</option>
                <option value="Low">Low</option>
                <option value="Moderate">Moderate</option>
                <option value="High">High</option>
              </select>
            </div>
            <div>
              <label className={labelCls()}>Next inspection date</label>
              <input
                type="date"
                className={inputCls()}
                value={form.nextInspectionDate ?? ""}
                disabled={!canEdit}
                onChange={(e) =>
                  setForm({ nextInspectionDate: e.target.value || null })
                }
              />
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls()}>Risk notes</label>
              <textarea
                className={inputCls()}
                rows={2}
                value={form.riskNotes ?? ""}
                disabled={!canEdit}
                onChange={(e) => setForm({ riskNotes: e.target.value })}
                placeholder="e.g. Deadwood over the patio — moderate risk until the crown cleaning is done."
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {canEdit && (
              <button
                disabled={!canSaveForm}
                onClick={() => {
                  if (form) {
                    saveTree(form);
                    setSelectedTreeId(form.id);
                    setEditingTree(null);
                  }
                }}
                className={primaryBtn()}
              >
                Save tree
              </button>
            )}
            {canEdit && trees.some((t) => t.id === form.id) && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete ${form.label}?`)) {
                    deleteTree(form.id);
                    setEditingTree(null);
                    setSelectedTreeId(null);
                  }
                }}
                className={dangerBtn()}
              >
                Delete tree
              </button>
            )}
            <button
              onClick={() => setEditingTree(null)}
              className={secondaryBtn()}
            >
              {canEdit ? "Cancel" : "Close"}
            </button>
          </div>
          {!canEdit && (
            <p className="mt-2 text-xs text-slate-500">
              Only the office and owners can change trees.
            </p>
          )}
        </section>
      )}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Tree inventory ({trees.length})
        </p>
        {trees.length === 0 ? (
          <p className="text-sm text-slate-500">
            No trees mapped yet
            {canEdit ? " — use “+ Add tree” and click the map." : "."}
          </p>
        ) : (
          <ul className="space-y-2">
            {[...trees]
              .sort((a, b) => a.label.localeCompare(b.label))
              .map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => openTreeFromList(t)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-left shadow-sm hover:border-emerald-500 ${
                      t.id === selectedTreeId
                        ? "border-emerald-600"
                        : "border-slate-200"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        className="inline-block h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: CONDITION_COLORS[t.condition] }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">
                          {t.label}
                          {t.species ? ` — ${t.species}` : ""}
                          {t.source === "Denver public record" && (
                            <span className="ml-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-bold text-sky-800">
                              PUBLIC RECORD
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {[t.dbh, t.height, t.status]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                    </span>
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold"
                      style={{
                        backgroundColor: `${CONDITION_COLORS[t.condition]}1a`,
                        color: CONDITION_COLORS[t.condition],
                      }}
                    >
                      {t.condition}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
