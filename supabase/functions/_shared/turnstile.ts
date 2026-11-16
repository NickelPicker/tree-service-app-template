// turnstile.ts — Cloudflare Turnstile check, same rule as book-estimate:
// until the TURNSTILE_SECRET_KEY function secret exists the check is
// skipped (the site key in src/config.ts is still a placeholder then,
// so the page shows no widget); limits and validation still apply.

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function turnstileOk(token: string, ip: string): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form });
    const data = await res.json();
    return data?.success === true;
  } catch {
    return false;
  }
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
