import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // Geometric sans for body/UI.
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        // Editorial serif for headings.
        serif: ["var(--font-newsreader)", "Newsreader", "Georgia", "serif"],
        // Monospace for meta/code/blob-ids.
        mono: ["var(--font-geist-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        // Warm monochrome foundation.
        canvas: "#F7F6F3", // warm bone background
        surface: "#FFFFFF", // card surface
        border: "#EAEAEA", // structural borders/dividers
        ink: "#111111", // primary text (off-black)
        muted: "#787774", // secondary/muted text
        // Muted pastel accents (tags, badges, subtle icon backgrounds).
        pastel: {
          red: "#FDEBEC",
          redText: "#9F2F2D",
          blue: "#E1F3FE",
          blueText: "#1F6C9F",
          green: "#EDF3EC",
          greenText: "#346538",
          yellow: "#FBF3DB",
          yellowText: "#956400",
        },
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      animation: {
        "skeleton-pulse": "skeleton-pulse 1.8s ease-in-out infinite",
        "fade-in": "fade-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards",
        "slide-up": "slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards",
      },
      keyframes: {
        "skeleton-pulse": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "0.7" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
