import { defineConfig } from "vitest/config";

/**
 * Workspace-root Vitest config.
 *
 * Picks up tests from every package under `packages/*` so a single `pnpm test`
 * (or `npm test`) at the root runs property tests, unit tests, and integration
 * tests across the shared library, the MCP server, and the dashboard.
 *
 * The default test environment is `node` so the bulk of the suite (shared
 * library properties, MCP-server integration, server-side dashboard logic)
 * stays fast. Component tests under `packages/dashboard/src/components`
 * opt into `jsdom` per file via the `// @vitest-environment jsdom`
 * pragma at the top of each test file.
 *
 * `esbuild.jsx = "automatic"` is required because the dashboard's
 * `tsconfig.json` uses `"jsx": "preserve"` (Next.js compiles JSX itself),
 * so Vitest's esbuild transform would otherwise leave JSX untouched and
 * fail to compile `.test.tsx` files.
 */
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: ["packages/*/src/**/*.{test,spec}.{ts,tsx}"],
    environment: "node",
    globals: false,
    passWithNoTests: true,
    reporters: ["default"],
  },
});
