import { useState } from "react";
import type { Invoice } from "../types";
import { docTotals } from "./ui";
import { money } from "../utils";

export type ChartX = "customer" | "status" | "month" | "type";
export type ChartY = "total" | "outstanding" | "count";

const COLORS = [
  "#047857",
  "#0284c7",
  "#d97706",
  "#e11d48",
  "#7c3aed",
  "#64748b",
  "#65a30d",
  "#db2777",
  "#0891b2",
  "#475569",
];

export function invoiceTotal(i: Invoice): number {
  return docTotals(
    i.lines,
    i.taxRate,
    i.discountType ?? "none",
    i.discountValue ?? 0,
  ).total;
}

/** What is still owed on an invoice: 0 when paid, else the unpaid splits (or the whole total when there are no splits). */
export function invoiceOutstanding(i: Invoice): number {
  if (i.status === "paid") return 0;
  const total = invoiceTotal(i);
  if (i.splits.length === 0) return total;
  return i.splits
    .filter((s) => !s.paid)
    .reduce(
      (sum, s) =>
        sum + (s.kind === "percentage" ? (total * s.value) / 100 : s.value),
      0,
    );
}

function fmtValue(v: number, y: ChartY): string {
  if (y === "count") return String(Math.round(v));
  return v >= 10000 ? `$${(v / 1000).toFixed(1)}k` : money(v);
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

interface Slice {
  label: string;
  value: number;
}

function aggregate(
  invoices: Invoice[],
  x: ChartX,
  y: ChartY,
  customerLabel: (id: string) => string,
  customerType: (id: string) => "commercial" | "residential",
): Slice[] {
  const measure = (i: Invoice) =>
    y === "total"
      ? invoiceTotal(i)
      : y === "outstanding"
        ? invoiceOutstanding(i)
        : 1;
  const groups = new Map<string, number>();
  for (const inv of invoices) {
    let key: string;
    if (x === "customer") key = customerLabel(inv.customerId);
    else if (x === "status") key = inv.status;
    else if (x === "month") key = inv.issuedDate.slice(0, 7);
    else
      key =
        customerType(inv.customerId) === "commercial"
          ? "Commercial"
          : "Residential";
    groups.set(key, (groups.get(key) ?? 0) + measure(inv));
  }
  let rows = [...groups.entries()].map(([label, value]) => ({
    label: x === "month" ? monthLabel(label) : label,
    value,
    sort: label,
  }));
  // Months read oldest → newest; everything else biggest first.
  rows.sort((a, b) =>
    x === "month" ? a.sort.localeCompare(b.sort) : b.value - a.value,
  );
  // Customers: top 8, the rest rolled into "Other".
  if (x === "customer" && rows.length > 8) {
    const top = rows.slice(0, 8);
    const other = rows
      .slice(8)
      .reduce((s, r) => s + r.value, 0);
    rows = [...top, { label: "Other", value: other, sort: "Other" }];
  }
  return rows.map(({ label, value }) => ({ label, value }));
}

function BarChart({ data, y }: { data: Slice[]; y: ChartY }) {
  const max = Math.max(...data.map((d) => d.value), 0);
  const W = 400;
  const H = 230;
  const base = 195;
  const top = 25;
  const slot = W / Math.max(data.length, 1);
  const barW = Math.min(48, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
      <line x1={0} y1={base} x2={W} y2={base} stroke="#cbd5e1" strokeWidth={1} />
      {data.map((d, i) => {
        const h = max > 0 ? ((base - top) * d.value) / max : 0;
        const cx = slot * i + slot / 2;
        return (
          <g key={d.label}>
            <rect
              x={cx - barW / 2}
              y={base - h}
              width={barW}
              height={h}
              rx={3}
              fill={COLORS[i % COLORS.length]}
            />
            <text
              x={cx}
              y={base - h - 6}
              textAnchor="middle"
              fontSize={11}
              fontWeight={700}
              fill="#0f172a"
            >
              {fmtValue(d.value, y)}
            </text>
            <text
              x={cx}
              y={base + 16}
              textAnchor="middle"
              fontSize={10}
              fill="#475569"
            >
              {d.label.length > 12
                ? `${d.label.slice(0, 11)}…`
                : d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PieChart({ data, y }: { data: Slice[]; y: ChartY }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const cx = 110;
  const cy = 110;
  const r = 88;
  let angle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const frac = total > 0 ? d.value / total : 0;
    const start = angle;
    angle += frac * Math.PI * 2;
    const end = angle;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const path =
      frac >= 1
        ? `M ${cx} ${cy} m ${-r} 0 a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`
        : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return { d, path, color: COLORS[i % COLORS.length], frac };
  });
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 220 220" className="h-44 w-44 shrink-0">
        {slices.map((s) => (
          <path key={s.d.label} d={s.path} fill={s.color} />
        ))}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-sm">
        {slices.map((s) => (
          <li key={s.d.label} className="flex items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="min-w-0 flex-1 truncate text-slate-700">
              {s.d.label}
            </span>
            <span className="shrink-0 font-semibold text-slate-900">
              {fmtValue(s.d.value, y)}
            </span>
            <span className="w-10 shrink-0 text-right text-slate-500">
              {Math.round(s.frac * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Invoices chart: pie or bar, with the X axis (what the slices/bars are)
 * and the Y axis (what they measure) both switchable. Always drawn from
 * the invoices currently on the page — search and status filter apply.
 */
export default function InvoiceChart({
  invoices,
  customerLabel,
  customerType,
}: {
  invoices: Invoice[];
  customerLabel: (id: string) => string;
  customerType: (id: string) => "commercial" | "residential";
}) {
  const [chartType, setChartType] = useState<"pie" | "bar">("bar");
  const [x, setX] = useState<ChartX>("customer");
  const [y, setY] = useState<ChartY>("total");
  const data = aggregate(invoices, x, y, customerLabel, customerType);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(["pie", "bar"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setChartType(t)}
              className={`rounded-full px-3 py-1 text-sm font-semibold ${
                chartType === t
                  ? "bg-emerald-700 text-white"
                  : "border border-slate-300 bg-white text-slate-700"
              }`}
            >
              {t === "pie" ? "Pie" : "Bar"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-sm text-slate-600">
          X:
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-semibold"
            value={x}
            onChange={(e) => setX(e.target.value as ChartX)}
          >
            <option value="customer">Customer</option>
            <option value="status">Status</option>
            <option value="month">Month issued</option>
            <option value="type">Type</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-sm text-slate-600">
          Y:
          <select
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-semibold"
            value={y}
            onChange={(e) => setY(e.target.value as ChartY)}
          >
            <option value="total">Total invoiced</option>
            <option value="outstanding">Outstanding</option>
            <option value="count">Count</option>
          </select>
        </label>
      </div>
      {data.length === 0 || data.every((d) => d.value === 0) ? (
        <p className="text-sm text-slate-500">
          Nothing to chart for the current filters.
        </p>
      ) : chartType === "bar" ? (
        <BarChart data={data} y={y} />
      ) : (
        <PieChart data={data} y={y} />
      )}
    </div>
  );
}
