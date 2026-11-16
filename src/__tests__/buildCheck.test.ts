import { describe, expect, it } from "vitest";
import { buildAction, latestBuildId, reloadAllowed } from "../buildCheck";
import { buildVersion } from "../../vite.config";

/**
 * Open phones and tabs move to a new deploy by themselves (review of
 * audit 2, #11): an old build left open must not keep running against a
 * database that has moved on.
 */
describe("a new deploy reaches open phones and tabs", () => {
  it("reloads onto a newer build once nothing unsaved would be lost", () => {
    expect(buildAction("abc", "def", false)).toBe("reload");
    expect(buildAction("abc", "def", true)).toBe("wait");
    expect(buildAction("abc", "abc", false)).toBe("current");
    expect(buildAction("abc", null, false)).toBe("current");
    // The dev server never reloads by itself.
    expect(buildAction("dev", "def", false)).toBe("current");
  });

  it("reads the newest build id, and treats no signal as nothing new", async () => {
    const ok = (async () => new Response(JSON.stringify({ build: "b2" }))) as unknown as typeof fetch;
    expect(await latestBuildId(ok)).toBe("b2");
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await latestBuildId(offline)).toBeNull();
    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect(await latestBuildId(html)).toBeNull();
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await latestBuildId(missing)).toBeNull();
  });

  it("never reloads over and over for the same build", () => {
    const now = 1_000_000_000;
    expect(reloadAllowed("b2", null, now)).toBe(true);
    expect(reloadAllowed("b2", `b2@${now - 60_000}`, now)).toBe(false);
    expect(reloadAllowed("b2", `b2@${now - 11 * 60_000}`, now)).toBe(true);
    expect(reloadAllowed("b3", `b2@${now - 60_000}`, now)).toBe(true);
  });

  it("the build writes version.json with its id", () => {
    const files: Array<{ fileName: string; source: string }> = [];
    const plugin = buildVersion("b9");
    (plugin.generateBundle as unknown as (this: unknown) => void).call({
      emitFile: (f: { fileName: string; source: string }) => files.push(f),
    });
    expect(files).toEqual([{ type: "asset", fileName: "version.json", source: '{"build":"b9"}' }]);
  });
});
