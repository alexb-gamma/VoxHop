/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  // EN-01 / Architect Note 1: Tailwind >=3.3.0 ships gray-950 natively.
  // package.json pins tailwindcss >= 3.3.0 to ensure gray-950 is available.
  // If below 3.3, use zinc-950 (#09090b) or extend colors.gray-950.
  theme: {
    extend: {},
  },
  plugins: [],
};
