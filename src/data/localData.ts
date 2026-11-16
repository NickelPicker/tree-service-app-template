/**
 * Removes every copy of company data this browser keeps (audit SEC-4):
 * the Supabase adapter's cached company state and drafts, the kept
 * New invoice pop-up draft (src/invoiceCompose.ts) (all
 * `treeapp:` keys), session storage, and the service worker's caches.
 * Called before sign-out (so the data is gone even if the network call
 * fails), when a session ends, and when a login turns out to have no
 * access. Personal layout preferences (tab order) are kept: they hold
 * no customer data.
 */
export async function clearLocalCompanyData(): Promise<void> {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("treeapp:")) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode): nothing was stored.
  }
  try {
    sessionStorage.clear();
  } catch {
    // Ignore.
  }
  try {
    if (typeof caches !== "undefined") {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } catch {
    // Ignore: the service worker only caches app files.
  }
}
