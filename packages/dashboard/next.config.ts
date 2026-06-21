import path from "node:path";

import type { NextConfig } from "next";

/**
 * Next.js configuration for the Uberwal dashboard.
 *
 * Three settings, each there to make the workspace build cleanly:
 *
 * 1. `transpilePackages: ["@uberwal/shared"]`
 *    The shared library exposes its TypeScript source (its `package.json`
 *    points `main` / `exports` at `./src/index.ts`). By default Next does
 *    not run workspace dependencies through SWC; this flag lets it compile
 *    `shared/src/*.ts` into the dashboard bundle.
 *
 * 2. `webpack.resolve.extensionAlias` mapping `.js` -> `.ts`/`.tsx`/`.js`
 *    The shared library uses `.js` ESM specifiers internally
 *    (`from "./validation.js"`) — the standard TypeScript ESM pattern that
 *    `tsc` and Vitest's esbuild transform resolve transparently. Next's
 *    webpack does not strip `.js` to retry `.ts`, so without this alias
 *    the import graph fails with `Module not found: ./validation.js`.
 *    Webpack 5's `extensionAlias` rewrites the lookup order to try
 *    TypeScript sources first, matching how the rest of the repo already
 *    consumes the package.
 *
 * 3. `outputFileTracingRoot`
 *    The repo lives inside a parent directory that also contains a
 *    `pnpm-lock.yaml`, which causes Next to log a warning that it inferred
 *    the wrong workspace root. Pinning the trace root to the actual
 *    monorepo root (`<dashboard>/../..`) silences the warning and ensures
 *    file tracing for the standalone build only walks the Uberwal tree.
 */
const config: NextConfig = {
  transpilePackages: ["@uberwal/shared"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  webpack: (webpackConfig) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.extensionAlias = {
      ...(webpackConfig.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return webpackConfig;
  },
};

export default config;
