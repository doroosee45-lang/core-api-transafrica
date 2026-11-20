import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { setupHarness, type Harness } from "./support/harness.js";

/**
 * Garde-fou : chaque route du registre (source de l'OpenAPI) doit être appelée par au moins
 * un test HTTP. Une route ajoutée sans test fait échouer la suite (audit du 20/11/2026 :
 * 37 routes sur 145 n'étaient exercées par aucun test).
 */
let h: Harness;
beforeAll(async () => { h = await setupHarness(); });
afterAll(async () => { await h?.teardown(); });

it("toutes les routes de l'API sont exercées par au moins un test", async () => {
  const { registry } = await import("../src/core/routes.js");
  const dir = path.resolve("tests");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".test.ts") && f !== "route-inventory.test.ts")
    .map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const untested = registry.filter((r) => {
    const p = r.path.split("/").map((seg) => (seg.startsWith(":") ? "(?:\\$\\{[^}]+\\}|[^/\"'`?]+)" : esc(seg))).join("/");
    return !new RegExp(`\\.${r.method}\\(\\s*[\`"']/api/v1${p}(?:[?"'\`]|$)`).test(sources);
  }).map((r) => `${r.method.toUpperCase()} ${r.path}`);
  expect(registry.length).toBeGreaterThan(100);
  expect(untested).toEqual([]);
});
