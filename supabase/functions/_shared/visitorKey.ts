// visitorKey.ts — who is asking, for the public pages' rate limits
// (book-estimate, estimate-accept). Pure functions: no Deno APIs, so the
// app's vitest suite tests them (src/__tests__/bookingLimits.test.ts).
//
// The raw IP is never stored: the functions store a salted SHA-256 of
// visitorBucket(ip), and the salt is a function secret.

/**
 * The visitor's IP as the platform saw it. Cloudflare (in front of
 * Supabase) sets CF-Connecting-IP itself and overwrites any value the
 * visitor sends, so it wins. X-Forwarded-For is a list the visitor can
 * start with made-up entries, so it is only the last resort.
 */
export function clientIp(headers: { get(name: string): string | null }): string {
  const cf = (headers.get("cf-connecting-ip") ?? "").trim();
  if (cf) return cf;
  const real = (headers.get("x-real-ip") ?? "").trim();
  if (real) return real;
  return (headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
}

/**
 * The part of an address one visitor controls: an IPv4 address as is;
 * an IPv6 address cut to its /64 network, because one home or phone
 * gets a whole /64 and can pick a new address in it for every request.
 */
export function visitorBucket(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!raw.includes(":")) return raw || "unknown";
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is really IPv4.
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  const [head, tail] = raw.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = raw.includes("::") ? 8 - headParts.length - tailParts.length : 0;
  const parts = [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts];
  if (parts.length < 4 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return raw;
  return parts
    .slice(0, 4)
    .map((p) => p.replace(/^0+(?=.)/, ""))
    .join(":") + "::/64";
}

/**
 * A booking's phone number as digits only, last 10 (so "+1 (555)
 * 555-0101" and "555.555.0101" are the same person); "" when it has
 * too few digits to mean anything.
 */
export function phoneKey(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : "";
}

/** Why a public booking was turned away, in plain words for the page. */
export const BOOKING_LIMIT_MESSAGES: Record<string, string> = {
  visitor: "Too many requests from this connection or phone number. Please try again later, or call us.",
  daily: "We've had a lot of booking requests today. Please call us, or try again tomorrow.",
  backlog: "We have a lot of booking requests waiting. Please call us instead.",
};

/** Limits for public booking requests (see the "booking daily cap" rules). */
export const BOOKING_LIMITS = {
  /** Per visitor (IP, or IPv6 /64) per hour. */
  perVisitorPerHour: 5,
  /** Per phone number per day. */
  perPhonePerDay: 3,
  /** Everyone together, per day (rolling 24 hours). */
  perDay: 40,
  /** Waiting (pending) requests at most; past this the page says call us. */
  maxPending: 300,
} as const;
