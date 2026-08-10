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
          bg: "#0F1418",
          panel: "#161D23",
          accent: "#3DDC97",
          line: "#2A343B",
        },
      },
    },
  },
  plugins: [],
};

export default config;
