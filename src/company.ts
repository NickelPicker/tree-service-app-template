import type { AppSettings, AppState, CompanyProfile, CompanySite } from "./types";

/**
 * Company profile helpers — the one place the app reads "who is this
 * business". The profile lives in settings.company (set by the
 * first-run setup wizard, editable in Schedule → Calendar settings →
 * Company). Nothing else in the app hardcodes a business name, phone
 * number, shop address, or payment detail: every display string
 * below falls back to a plain generic label when the profile is
 * missing, so an unconfigured copy never shows someone else's
 * details.
 */

/** The company profile on these settings, or null when unset. */
export function companyProfile(
  settings: AppSettings | null | undefined,
): CompanyProfile | null {
  return settings?.company ?? null;
}

/** True once the setup wizard has been completed. */
export function isCompanyConfigured(
  settings: AppSettings | null | undefined,
): boolean {
  return (settings?.company?.name ?? "").trim().length > 0;
}

/** Business name for display; generic until the wizard is done. */
export function companyName(
  state: AppState | null | undefined,
): string {
  return state?.settings.company?.name?.trim() || "Your Tree Service";
}

/** Business phone for display ("" when unset). */
export function companyPhone(
  state: AppState | null | undefined,
): string {
  return state?.settings.company?.phone?.trim() ?? "";
}

/**
 * The number customers get texts from: the profile's texting
 * number, else the business phone, else "" (callers show a generic
 * "your business number" line when it is blank).
 */
export function smsNumber(state: AppState | null | undefined): string {
  const c = state?.settings.company;
  return c?.smsNumber?.trim() || c?.phone?.trim() || "";
}

/** Logo to show in the header: the uploaded logo, else the generic mark. */
export function companyLogoSrc(
  state: AppState | null | undefined,
): string {
  return state?.settings.company?.logoDataUrl || "logo-mark.png";
}

/**
 * Clock-in spots with a known position: the profile's shop/yard
 * addresses that geocoded. An address that could not be placed on
 * the map is skipped here (clock-in still works from the crew
 * member's first job site of the day).
 */
export function clockInSites(
  state: AppState,
): Array<{ label: string; coords: { lat: number; lng: number } }> {
  const sites = state.settings.company?.sites ?? [];
  return sites
    .filter(
      (s): s is CompanySite & { lat: number; lng: number } =>
        s.lat != null && s.lng != null,
    )
    .map((s) => ({
      label: s.label || s.address,
      coords: { lat: s.lat, lng: s.lng },
    }));
}

/** A blank profile for the wizard / company form to start from. */
export function emptyCompanyProfile(ownerEmail = ""): CompanyProfile {
  return {
    name: "",
    phone: "",
    email: "",
    smsNumber: "",
    logoDataUrl: null,
    ownerEmail,
    sites: [{ label: "Shop", address: "", lat: null, lng: null }],
    zelleNumber: "",
    checkPayee: "",
    checkMailingAddress: "",
  };
}
