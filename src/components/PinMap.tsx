import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Small click-to-drop pin map for a job location. Used when a job is
 * located by GPS pin instead of (or in addition to) a street address
 * — work in a random field with no address. Clicking the map drops
 * (or moves) the pin; the parent stores lat/lng on the job.
 */
export default function PinMap({
  lat,
  lng,
  center,
  disabled,
  onPick,
}: {
  lat: number | null;
  lng: number | null;
  /** Fallback center when no pin is set (e.g. the customer's map location). */
  center?: [number, number] | null;
  disabled: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const pinRef = useRef<L.Marker | null>(null);
  const onPickRef = useRef(onPick);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onPickRef.current = onPick;
    disabledRef.current = disabled;
  });

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const centerPos: [number, number] =
      lat !== null && lng !== null
        ? [lat, lng]
        : center ?? [39.7392, -104.9903];
    const map = L.map(mapEl.current, { zoomControl: true }).setView(
      centerPos,
      lat !== null && lng !== null ? 16 : center ? 14 : 11,
    );
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
        maxZoom: 19,
      },
    ).addTo(map);
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (disabledRef.current) return;
      onPickRef.current(e.latlng.lat, e.latlng.lng);
    });
    mapRef.current = map;
    const timer = window.setTimeout(() => map.invalidateSize(), 200);
    return () => {
      window.clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
    // Mount-only: the parent remounts per job via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (pinRef.current) {
      pinRef.current.remove();
      pinRef.current = null;
    }
    if (lat === null || lng === null) return;
    const pin = L.marker([lat, lng], {
      icon: L.divIcon({
        className: "",
        html: `<span style="width:20px;height:20px;border-radius:9999px;background:#dc2626;border:2px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:800;">📍</span>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
      draggable: !disabled,
      title: "Job pin (drag to move)",
    });
    if (!disabled) {
      pin.on("dragend", () => {
        const ll = pin.getLatLng();
        onPickRef.current(ll.lat, ll.lng);
      });
    }
    pin.addTo(map);
    pinRef.current = pin;
    map.setView([lat, lng], Math.max(map.getZoom(), 15));
  }, [lat, lng, disabled]);

  return (
    <div
      ref={mapEl}
      className="h-[240px] w-full overflow-hidden rounded-xl border border-slate-200 shadow-sm"
    />
  );
}
