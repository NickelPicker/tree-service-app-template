import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useStore } from "../store";
import { emptyCompanyProfile } from "../company";
import { supabaseConfig } from "../config";
import { supabase } from "../data/supabaseClient";
import { geocodeAddress } from "../routing";
import type { CompanyProfile, CompanySite } from "../types";
import { inputCls, labelCls, primaryBtn, secondaryBtn } from "./ui";

/**
 * First-run setup wizard + the company details form.
 *
 * The wizard appears the first time the app opens with no company
 * configured (see App.tsx) and blocks the app until it is completed:
 * business name, logo (optional), phone, email, the number customers
 * get texts from, shop/yard addresses for clock-in, the owner login,
 * and how customers pay. Crew and equipment are added inside the app
 * afterwards.
 *
 * The same form is reused in Schedule → Calendar settings → Company,
 * so the details can be fixed later without re-running the wizard.
 * Everything saves through the normal settings save
 * (setCalendarSettings), so it lands in localStorage in preview mode
 * and in the settings row once Supabase is connected.
 */

/** One editable site row in the form. */
export function CompanyProfileForm({
  value,
  onChange,
  ownerEmailLocked,
  siteWarnings,
  disabled,
}: {
  value: CompanyProfile;
  onChange: (next: CompanyProfile) => void;
  /** In Supabase mode the owner email is the signed-in login: shown, not editable. */
  ownerEmailLocked: boolean;
  /** Geocode warnings, one per site row ("" = no warning). */
  siteWarnings: string[];
  disabled?: boolean;
}) {
  const set = (patch: Partial<CompanyProfile>) =>
    onChange({ ...value, ...patch });
  const setSite = (idx: number, patch: Partial<CompanySite>) => {
    const sites = value.sites.map((s, i) =>
      i === idx ? { ...s, ...patch } : s,
    );
    onChange({ ...value, sites });
  };
  const addSite = () =>
    onChange({
      ...value,
      sites: [
        ...value.sites,
        { label: `Site ${value.sites.length + 1}`, address: "", lat: null, lng: null },
      ],
    });
  const removeSite = (idx: number) => {
    if (value.sites.length <= 1) return;
    onChange({ ...value, sites: value.sites.filter((_, i) => i !== idx) });
  };

  const onLogoFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1_500_000) {
      window.alert(
        "That image is over 1.5 MB — please pick a smaller logo file (a phone photo of a sign usually works if you crop it tight).",
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      if (dataUrl.startsWith("data:image/")) set({ logoDataUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className={labelCls()} htmlFor="company-name">
          Business name *
        </label>
        <input
          id="company-name"
          type="text"
          required
          disabled={disabled}
          className={inputCls()}
          value={value.name}
          placeholder="e.g. Acme Tree Care"
          onChange={(e) => set({ name: e.target.value })}
        />
        <p className="mt-1 text-xs text-slate-500">
          Shown at the top of the app and on estimates and invoices.
        </p>
      </div>

      <div>
        <label className={labelCls()} htmlFor="company-logo">
          Logo (optional)
        </label>
        <div className="flex items-center gap-3">
          {value.logoDataUrl ? (
            <img
              src={value.logoDataUrl}
              alt="Business logo preview"
              className="h-14 w-14 rounded-full object-cover"
            />
          ) : (
            <img
              src="logo-mark.png"
              alt="Generic tree logo"
              className="h-14 w-14 rounded-full object-cover"
            />
          )}
          <div className="flex flex-wrap gap-2">
            <label className={`${secondaryBtn()} cursor-pointer`}>
              Upload a logo
              <input
                id="company-logo"
                type="file"
                accept="image/*"
                disabled={disabled}
                className="hidden"
                onChange={onLogoFile}
              />
            </label>
            {value.logoDataUrl && (
              <button
                type="button"
                disabled={disabled}
                className={secondaryBtn()}
                onClick={() => set({ logoDataUrl: null })}
              >
                Use the generic tree
              </button>
            )}
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          A square image works best. It is stored inside the app — no
          file hosting needed.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls()} htmlFor="company-phone">
            Business phone
          </label>
          <input
            id="company-phone"
            type="tel"
            disabled={disabled}
            className={inputCls()}
            value={value.phone}
            placeholder="(555) 555-0100"
            onChange={(e) => set({ phone: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls()} htmlFor="company-email">
            Business email
          </label>
          <input
            id="company-email"
            type="email"
            disabled={disabled}
            className={inputCls()}
            value={value.email}
            placeholder="hello@acmetree.example"
            onChange={(e) => set({ email: e.target.value })}
          />
        </div>
      </div>

      <div>
        <label className={labelCls()} htmlFor="company-sms">
          Number customers get texts from
        </label>
        <input
          id="company-sms"
          type="tel"
          disabled={disabled}
          className={inputCls()}
          value={value.smsNumber}
          placeholder="Same as the business phone if left blank"
          onChange={(e) => set({ smsNumber: e.target.value })}
        />
        <p className="mt-1 text-xs text-slate-500">
          Every text a customer gets comes from this one number — never
          from a crew member&apos;s personal phone. Leave it blank to
          use the business phone.
        </p>
      </div>

      <div>
        <label className={labelCls()} htmlFor="company-owner-email">
          Owner login (email) *
        </label>
        <input
          id="company-owner-email"
          type="email"
          required
          disabled={disabled || ownerEmailLocked}
          className={inputCls()}
          value={value.ownerEmail}
          placeholder="you@example.com"
          onChange={(e) => set({ ownerEmail: e.target.value })}
        />
        <p className="mt-1 text-xs text-slate-500">
          {ownerEmailLocked
            ? "This is the login you signed in with — it is the owner account, so it can't be changed here."
            : "The email the owner uses to sign in. In the live app only the owner email set in the database becomes the owner, after it is confirmed."}
        </p>
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-700">
          Shop / yard addresses (for clock-in)
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Crew can clock in within 0.25 miles of one of these, or at
          their first job site of the day. Add every yard or shop the
          crew starts from — you can change these later in Schedule →
          Calendar settings → Company.
        </p>
        <div className="mt-2 space-y-3">
          {value.sites.map((site, idx) => (
            <div key={idx} className="rounded-xl border border-slate-200 p-3">
              <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto]">
                <div>
                  <label className={labelCls()} htmlFor={`site-label-${idx}`}>
                    Label
                  </label>
                  <input
                    id={`site-label-${idx}`}
                    type="text"
                    disabled={disabled}
                    className={inputCls()}
                    value={site.label}
                    placeholder="Shop"
                    onChange={(e) => setSite(idx, { label: e.target.value })}
                  />
                </div>
                <div>
                  <label className={labelCls()} htmlFor={`site-address-${idx}`}>
                    Street address
                  </label>
                  <input
                    id={`site-address-${idx}`}
                    type="text"
                    disabled={disabled}
                    className={inputCls()}
                    value={site.address}
                    placeholder="123 Main St, Anytown, CO"
                    onChange={(e) => setSite(idx, { address: e.target.value })}
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    disabled={disabled || value.sites.length <= 1}
                    className={secondaryBtn()}
                    onClick={() => removeSite(idx)}
                  >
                    Remove
                  </button>
                </div>
              </div>
              {siteWarnings[idx] && (
                <p className="mt-2 text-xs font-semibold text-amber-700">
                  ⚠ {siteWarnings[idx]}
                </p>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={disabled}
          className={`${secondaryBtn()} mt-2`}
          onClick={addSite}
        >
          + Add another shop / yard
        </button>
      </div>

      <div>
        <p className="text-sm font-semibold text-slate-700">
          How customers pay you (optional)
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Shown on every invoice as &ldquo;How to pay&rdquo;. Leave a
          line blank to leave it off the invoice.
        </p>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls()} htmlFor="company-zelle">
              Zelle number
            </label>
            <input
              id="company-zelle"
              type="tel"
              disabled={disabled}
              className={inputCls()}
              value={value.zelleNumber}
              placeholder="(555) 555-0100"
              onChange={(e) => set({ zelleNumber: e.target.value })}
            />
          </div>
          <div>
            <label className={labelCls()} htmlFor="company-check-payee">
              Checks payable to
            </label>
            <input
              id="company-check-payee"
              type="text"
              disabled={disabled}
              className={inputCls()}
              value={value.checkPayee}
              placeholder="Usually your business name"
              onChange={(e) => set({ checkPayee: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls()} htmlFor="company-check-mail">
              Mail checks to
            </label>
            <input
              id="company-check-mail"
              type="text"
              disabled={disabled}
              className={inputCls()}
              value={value.checkMailingAddress}
              placeholder="Street address, city, state, ZIP"
              onChange={(e) => set({ checkMailingAddress: e.target.value })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Place each non-empty shop/yard address on the map. An address that
 * can't be placed is kept as text (with a warning) — clock-in still
 * works from the first job site, and the address can be fixed later.
 * Shared by the wizard and the Company section in Calendar settings.
 */
export async function geocodeCompanySites(
  sites: CompanySite[],
): Promise<{ sites: CompanySite[]; warnings: string[] }> {
  const warnings: string[] = [];
  const placed: CompanySite[] = [];
  for (const site of sites) {
    const address = site.address.trim();
    if (!address) {
      warnings.push("");
      continue;
    }
    const coords = await geocodeAddress(address);
    if (!coords) {
      warnings.push(
        `Couldn't place "${address}" on the map — check the spelling. Clock-in from this spot won't work until it is placed.`,
      );
    } else {
      warnings.push("");
    }
    placed.push({
      label: site.label.trim() || "Shop",
      address,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    });
  }
  return { sites: placed, warnings };
}

export default function SetupWizard() {
  const { setCalendarSettings, authUser, supabaseMode, saveStatus, saveError } =
    useStore();
  const [profile, setProfile] = useState<CompanyProfile>(() =>
    emptyCompanyProfile(authUser?.email ?? ""),
  );
  const [siteWarnings, setSiteWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = profile.name.trim();
    const ownerEmail = profile.ownerEmail.trim();
    if (!name) {
      setError("Please enter your business name.");
      return;
    }
    if (!ownerEmail || !ownerEmail.includes("@")) {
      setError("Please enter the owner login email.");
      return;
    }
    setBusy(true);
    setError(null);
    setSiteWarnings([]);
    // Place each shop/yard address on the map (see geocodeCompanySites).
    const { sites, warnings } = await geocodeCompanySites(profile.sites);
    setSiteWarnings(warnings);
    const finalProfile: CompanyProfile = {
      ...profile,
      name,
      phone: profile.phone.trim(),
      email: profile.email.trim(),
      smsNumber: profile.smsNumber.trim(),
      ownerEmail,
      sites,
      zelleNumber: profile.zelleNumber.trim(),
      checkPayee: profile.checkPayee.trim(),
      checkMailingAddress: profile.checkMailingAddress.trim(),
    };
    setCalendarSettings({ company: finalProfile });
    // Best-effort: keep the company row's name in step too, so the
    // Supabase dashboard shows the real business name. The app never
    // reads that row, so a failure here changes nothing in the app.
    if (supabaseMode && supabase) {
      try {
        await supabase
          .from("companies")
          .update({ name })
          .eq("id", supabaseConfig.companyId);
      } catch {
        // Ignore — the profile above is what the app uses.
      }
    }
    setBusy(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-8">
      <form
        onSubmit={submit}
        className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <img src="logo-mark.png" alt="Your Tree Company logo" className="h-14 w-14 rounded-full object-cover" />
        <p className="mt-3 text-xl font-bold text-slate-900">
          🌲 Set up your tree service
        </p>
        <p className="mt-1 text-sm text-slate-500">
          This copy of the app starts empty — no business, crew, or
          customers yet. Tell it about your business once, and
          you&apos;re in. Crew and equipment come next, inside the app.
        </p>
        {!supabaseMode && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            You&apos;re trying the preview — these details are saved
            only in this browser for now. Once you connect your own
            Supabase project (see the README), you&apos;ll answer these
            same questions once more and they&apos;ll be saved for the
            whole team.
          </p>
        )}
        <div className="mt-4">
          <CompanyProfileForm
            value={profile}
            onChange={setProfile}
            ownerEmailLocked={supabaseMode}
            siteWarnings={siteWarnings}
            disabled={busy}
          />
        </div>
        {(error || (saveStatus === "error" && saveError)) && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error ?? saveError}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !profile.name.trim() || !profile.ownerEmail.trim()}
          className={`${primaryBtn()} mt-5 w-full`}
        >
          {busy ? "Placing your shop addresses on the map…" : "Finish setup — open the app"}
        </button>
        <p className="mt-3 text-xs text-slate-500">
          Nothing here is shared with anyone. Your business details
          live in your own database (or just this browser, in the
          preview).
        </p>
      </form>
    </div>
  );
}
