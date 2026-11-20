import { defineConfig } from "vitest/config";

// globals : les fonctions de test sont injectées par le runner. Sous Windows, une
// différence de casse de lettre de lecteur (d: / D:) peut sinon charger deux
// instances de "vitest" ("failed to find the runner").
export default defineConfig({
  test: {
    globals: true,
    globalSetup: ["tests/support/global-setup.ts"],
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: "forks",
  },
});
