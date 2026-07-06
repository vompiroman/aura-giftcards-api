import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.integration.test.ts"],
    environment: "node",
    globals: false,
    // Pas d'appels réseau réels : timeouts courts suffisent.
    testTimeout: 10_000,
    // Handler pur + mocks : la parallélisation est sûre ici (aucun état partagé).
    restoreMocks: true,
    clearMocks: true,
  },
});
