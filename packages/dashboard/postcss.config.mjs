/**
 * PostCSS configuration for the Uberwal dashboard.
 *
 * Next.js only runs Tailwind when it finds a PostCSS config that registers the
 * `tailwindcss` plugin. Without this file the `@tailwind base/components/
 * utilities` directives in `globals.css` are never expanded, so none of the
 * utility classes are generated and the app renders as unstyled HTML.
 */
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
