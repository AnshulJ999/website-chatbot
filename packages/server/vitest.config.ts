import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs the real Worker, Durable Objects and D1 locally (dev mode: scripted brain, no Access or Turnstile).
export default defineConfig(async () => {
  const migrations = await readD1Migrations(resolve(__dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            DEV_MODE: "1",
            TOKEN_SECRET: "test-secret",
            API_TOKEN: "test-token",
            OMNARA_API_KEY: "unused",
            PUBLIC_URL: "http://chatbot.test",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"], testTimeout: 40_000 },
  };
});
