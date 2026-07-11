/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Rabsal Dawa palette — see graphic guidelines.
      colors: {
        'sky-night': '#071B38',
        'sky-deep':  '#0A2347',
        'lapis':     '#123B73',
        'sky-700':   '#1B4A87',
        'azure':     '#075794',
        'azure-glow':'#0E5C9E',
        'azure-soft':'#4388B6',
        'mist-100':  '#DCE7EE',
        'mist-200':  '#BFD3DE',
        'mist-300':  '#91B7D3',
        'jade':      '#71A675',
        'jade-soft': '#9CC0A0',
        'vermilion': '#C22920',
        'vermilion-lo':   '#D9594E',
        'vermilion-deep': '#9A2018',
        'amber-robe':'#D85C1B',
        'gold':      '#ECB320',
        'gold-soft': '#E9C56B',
        'bronze':    '#A28348',
        'cream':     '#F0EBDE',
        'cream-hi':  '#F8F5EE',
        'sand':      '#ECC8A2',
        'ink':       '#33414F',
        'ink-soft':  '#5E6B78',
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans:    ['Outfit', 'system-ui', '-apple-system', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // Cards float on sky — shadow is blue-cast, not grey.
        'sky':    '0 16px 40px -18px rgba(7,27,56,0.50)',
        'sky-hi': '0 28px 56px -20px rgba(7,27,56,0.55)',
        'warm':   '0 14px 36px -10px rgba(194,41,32,0.5)',
      },
    },
  },
  plugins: [],
}
