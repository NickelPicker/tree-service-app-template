// Your Tree Company — service worker for the installable phone app.
//
// Goal: the app opens with no signal (a crew member reopening it in a
// dead zone can still clock out and tap Done), and a new website build
// still reaches phones on the next open.
//
// - The app shell (index.html) is NETWORK-FIRST: every open with signal
//   gets the newest deploy. With no signal, the saved copy is used.
// - The build's files (/assets/*, hashed names that never change) are
//   saved on the phone: all of them the first time the app loads (from
//   /precache-manifest.json, written by vite.config.ts), and again for
//   each new build. A saved index.html is only replaced once every file
//   it needs is saved, so the offline copy always starts.
// - Files of old builds are removed once a newer build is fully saved.
// - Icons and the manifest are cache-first.
const SHELL_CACHE = "treeapp-shell-v3";
const ASSET_CACHE = "treeapp-assets-v1";
const KEEP = [SHELL_CACHE, ASSET_CACHE];
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon.png",
  "/logo.png",
  "/logo-mark.png",
];

/** The /assets/… files an index.html points at. */
function assetsInHtml(html) {
  const out = new Set();
  const re = /["'(]((?:\.?\/)?assets\/[^"'()\s?#]+)/g;
  let m;
  while ((m = re.exec(html))) out.add("/" + m[1].replace(/^\.?\//, ""));
  return [...out];
}

/**
 * Save this build on the phone: the files in the build's manifest and
 * the ones index.html names, then index.html itself. `indexResponse` is
 * an index.html already fetched (a navigation), else it is fetched here.
 * Resolves true when the whole build is saved. Never rejects.
 */
async function saveBuild(indexResponse) {
  try {
    const index = indexResponse || (await fetch("/index.html", { cache: "no-store" }));
    if (!index || !index.ok) return false;
    const html = await index.clone().text();
    let files = [];
    try {
      const res = await fetch("/precache-manifest.json", { cache: "no-store" });
      if (res.ok) {
        const body = await res.json();
        if (body && Array.isArray(body.files)) files = body.files.filter((f) => typeof f === "string");
      }
    } catch {
      // No manifest (dev server): the files index.html names are enough.
    }
    const wanted = [...new Set([...files, ...assetsInHtml(html)])];
    const assets = await caches.open(ASSET_CACHE);
    for (const f of wanted) {
      if (await assets.match(f)) continue;
      const r = await fetch(f, { cache: "no-store" });
      if (!r.ok) return false;
      await assets.put(f, r);
    }
    const shell = await caches.open(SHELL_CACHE);
    await shell.put("/index.html", index);
    // Old builds' files go only after this one is complete.
    const keep = new Set(wanted);
    for (const req of await assets.keys()) {
      if (!keep.has(new URL(req.url).pathname)) await assets.delete(req);
    }
    return true;
  } catch {
    return false;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await Promise.all(
        STATIC_ASSETS.map((f) =>
          fetch(f)
            .then((r) => (r.ok ? shell.put(f, r) : undefined))
            .catch(() => undefined),
        ),
      );
      await saveBuild(null);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Only our own site. Supabase, map tiles and every other outside
  // service pass through untouched.
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/precache-manifest.json" || url.pathname === "/sw.js" || url.pathname === "/version.json") return;

  // App shell: network first; the saved copy when there is no signal.
  if (event.request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) event.waitUntil(saveBuild(response.clone()));
          return response;
        })
        .catch(async () => (await caches.match("/index.html", { cacheName: SHELL_CACHE })) || Response.error()),
    );
    return;
  }

  // Build files: hashed names never change, so a saved copy is always right.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const hit = await cache.match(url.pathname);
        if (hit) return hit;
        const response = await fetch(event.request);
        if (response.ok) await cache.put(url.pathname, response.clone());
        return response;
      }),
    );
    return;
  }

  // Icons, manifest, logos: cache first, network as fallback.
  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
});
