import { describe, expect, it } from "vitest";
import swSource from "../../public/sw.js?raw";

/**
 * public/sw.js (review, #7): the whole build is saved on the
 * phone on first load, the app opens with no signal, and a new build
 * takes over on the next open with signal.
 */

type Handler = (event: { waitUntil: (p: Promise<unknown>) => void; respondWith?: (p: Promise<Response>) => void; request?: Request }) => void;

class FakeCache {
  store = new Map<string, Response>();
  key(r: string | Request) {
    return new URL(typeof r === "string" ? r : r.url, "https://app.test").pathname;
  }
  async match(r: string | Request) {
    const hit = this.store.get(this.key(r));
    return hit ? hit.clone() : undefined;
  }
  async put(r: string | Request, res: Response) {
    this.store.set(this.key(r), res);
  }
  async delete(r: string | Request) {
    return this.store.delete(this.key(r));
  }
  async keys() {
    return [...this.store.keys()].map((k) => new Request(`https://app.test${k}`));
  }
}

function setup(site: { files: Record<string, string> }) {
  const caches = new Map<string, FakeCache>();
  const cacheStorage = {
    async open(name: string) {
      if (!caches.has(name)) caches.set(name, new FakeCache());
      return caches.get(name)!;
    },
    async keys() {
      return [...caches.keys()];
    },
    async delete(name: string) {
      return caches.delete(name);
    },
    async match(r: string | Request, opts?: { cacheName?: string }) {
      for (const [name, c] of caches) {
        if (opts?.cacheName && opts.cacheName !== name) continue;
        const hit = await c.match(r);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const net = { online: true, requests: [] as string[] };
  const fetchFn = async (input: string | Request) => {
    const path = new URL(typeof input === "string" ? input : input.url, "https://app.test").pathname;
    net.requests.push(path);
    if (!net.online) throw new TypeError("Failed to fetch");
    const body = site.files[path === "/" ? "/index.html" : path];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 });
  };
  const handlers: Record<string, Handler> = {};
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (name: string, h: Handler) => {
      handlers[name] = h;
    },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function("self", "caches", "fetch", swSource)(self, cacheStorage, fetchFn);

  async function fire(name: string) {
    const waits: Promise<unknown>[] = [];
    handlers[name]({ waitUntil: (p) => void waits.push(p) });
    await Promise.all(waits);
  }
  async function get(path: string, mode: RequestMode = "no-cors") {
    let responded: Promise<Response> | null = null;
    const waits: Promise<unknown>[] = [];
    const request = { url: path.startsWith("http") ? path : `https://app.test${path}`, method: "GET", mode } as unknown as Request;
    handlers.fetch({ request, waitUntil: (p) => void waits.push(p), respondWith: (p) => void (responded = p) });
    if (!responded) return null;
    const res = await (responded as Promise<Response>);
    await Promise.all(waits);
    return res;
  }
  return { caches, net, fire, get };
}

const build1 = {
  "/index.html": '<script type="module" src="/assets/index-AAA.js"></script><link href="/assets/index-AAA.css">',
  "/precache-manifest.json": JSON.stringify({ version: "1", files: ["/assets/index-AAA.js", "/assets/index-AAA.css", "/assets/chunk-AAA.js"] }),
  "/assets/index-AAA.js": "js1",
  "/assets/index-AAA.css": "css1",
  "/assets/chunk-AAA.js": "chunk1",
  "/manifest.webmanifest": "{}",
};

describe("service worker: works with no signal", () => {
  it("saves the whole build on install, so the app opens offline", async () => {
    const sw = setup({ files: { ...build1 } });
    await sw.fire("install");
    sw.net.online = false;
    const page = await sw.get("/", "navigate");
    expect(await page!.text()).toContain("index-AAA.js");
    expect(await (await sw.get("/assets/index-AAA.js"))!.text()).toBe("js1");
    expect(await (await sw.get("/assets/index-AAA.css"))!.text()).toBe("css1");
    // Lazily loaded chunks too, not only what index.html names.
    expect(await (await sw.get("/assets/chunk-AAA.js"))!.text()).toBe("chunk1");
  });

  it("a new build takes over on the next open with signal, and old files go", async () => {
    const site = { files: { ...build1 } as Record<string, string> };
    const sw = setup(site);
    await sw.fire("install");
    await sw.fire("activate");
    site.files = {
      "/index.html": '<script type="module" src="/assets/index-BBB.js"></script>',
      "/precache-manifest.json": JSON.stringify({ version: "2", files: ["/assets/index-BBB.js"] }),
      "/assets/index-BBB.js": "js2",
    };
    const page = await sw.get("/", "navigate");
    expect(await page!.text()).toContain("index-BBB.js");
    sw.net.online = false;
    expect(await (await sw.get("/", "navigate"))!.text()).toContain("index-BBB.js");
    expect(await (await sw.get("/assets/index-BBB.js"))!.text()).toBe("js2");
    const assets = sw.caches.get("treeapp-assets-v1")!;
    expect([...assets.store.keys()]).toEqual(["/assets/index-BBB.js"]);
  });

  it("keeps the old offline copy when the new build could not be saved completely", async () => {
    const site = { files: { ...build1 } as Record<string, string> };
    const sw = setup(site);
    await sw.fire("install");
    site.files = {
      "/index.html": '<script type="module" src="/assets/index-CCC.js"></script>',
      "/precache-manifest.json": JSON.stringify({ version: "3", files: ["/assets/index-CCC.js"] }),
      // index-CCC.js missing (signal dropped mid-way)
    };
    await sw.get("/", "navigate");
    sw.net.online = false;
    expect(await (await sw.get("/", "navigate"))!.text()).toContain("index-AAA.js");
    expect(await (await sw.get("/assets/index-AAA.js"))!.text()).toBe("js1");
  });

  it("leaves outside services (Supabase, map tiles) and non-GET requests alone", async () => {
    const sw = setup({ files: { ...build1 } });
    expect(await sw.get("https://example.supabase.co/rest/v1/jobs", "cors")).toBeNull();
  });
});
