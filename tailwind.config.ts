import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Mapped onto the CSS custom properties in globals.css so the palette has
      // exactly one source of truth — utilities and component classes can never
      // drift apart.
      colors: {
        ink: "var(--surface-0)",
        panel: "var(--surface-1)",
        raised: "var(--surface-2)",
        edge: "var(--border)",
        "edge-strong": "var(--border-strong)",
        muted: "var(--text-dim)",
        faint: "var(--text-faint)",
        accent: "var(--accent)",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
