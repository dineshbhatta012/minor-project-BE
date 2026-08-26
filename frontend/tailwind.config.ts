import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        route: {
          bg: "#ECECEB",
          panel: "#E2E2E1",
          accent: "#b8b8b7",
          line: "#C4C4C3",
        },
      },
    },
  },
  plugins: [],
};

export default config;
