import { useEffect, useState } from "react";
import { supabase } from "./data/supabaseClient";
import { supabaseConfig } from "./config";

/**
 * Prices for Climbers (business rule): each part of the job
 * from the accepted estimate option — description and price — shown on
 * the Climber's job card. Groundsmen see no prices. Crew cannot read
 * estimates, so these come from the crew_job_prices() database function
 * (the "crew phone rules" rules), which returns
 * nothing to anyone but a Climber, and only for jobs they can see.
 */

export interface PriceLine {
  lineId: string;
  description: string;
  price: number;
}

/** Rows from crew_job_prices(), grouped by job, in the order returned. */
export function groupPriceRows(rows: unknown): Map<string, PriceLine[]> {
  const out = new Map<string, PriceLine[]>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Array<Record<string, unknown>>) {
    const jobId = typeof r.job_id === "string" ? r.job_id : null;
    if (!jobId) continue;
    const price = Number(r.price);
    const line: PriceLine = {
      lineId: typeof r.line_id === "string" ? r.line_id : "",
      description: typeof r.description === "string" ? r.description : "",
      price: Number.isFinite(price) ? price : 0,
    };
    const list = out.get(jobId) ?? [];
    list.push(line);
    out.set(jobId, list);
  }
  return out;
}

/**
 * The prices of the jobs this Climber can see, loaded once per screen.
 * Off (empty) for everyone else and in the preview without a database.
 */
export function useCrewPrices(enabled: boolean): Map<string, PriceLine[]> {
  const [prices, setPrices] = useState<Map<string, PriceLine[]>>(() => new Map());
  useEffect(() => {
    if (!enabled || !supabase) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc("crew_job_prices", {
          p_company_id: supabaseConfig.companyId,
        });
        if (!cancelled && !error) setPrices(groupPriceRows(data));
      } catch {
        // No signal: the prices simply don't show.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? prices : new Map();
}

/** A number from an rpc result, else null. */
export function priceOrNull(data: unknown): number | null {
  if (data === null || data === undefined || data === "") return null;
  const n = Number(data);
  return Number.isFinite(n) ? n : null;
}

/**
 * The current price a Climber's "Change the price" box shows, from the
 * database (crew_job_price_before_change, the "money fixes" rules):
 * the same figure that is struck through once he changes it (after
 * discount and tax). Null when off, unknown, or already replaced.
 */
export function useClimberPriceBeforeChange(enabled: boolean, jobId: string | null): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !jobId || !supabase) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase.rpc("crew_job_price_before_change", { p_job_id: jobId });
        if (!cancelled) setPrice(error ? null : priceOrNull(data));
      } catch {
        // No signal: the current price simply doesn't show.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, jobId]);
  return enabled ? price : null;
}
