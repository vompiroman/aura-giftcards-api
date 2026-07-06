import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    // Charge automatiquement .env.test (Vitest lit les .env selon le mode).
    env: {
      NODE_ENV: "test",
    },
    globals: false,
    // Appels réseau + RPC : on laisse de la marge.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // La suite est séquentielle (dépendance sur order_id) : un seul thread.
    pool: "threads",
    poolOptions: {
      threads: { singleThread: true },
    },
    // Pas de retry : un flaky doit être visible, pas masqué.
    retry: 0,
    // Filet de sécurité exécuté une fois, après TOUS les fichiers, même en cas d'échec.
    globalSetup: ["./tests/e2e/global-teardown.ts"],
  },
});
