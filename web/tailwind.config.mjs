/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        accent: '#428a91',
        'accent-dark': '#2d626a',
        'accent-light': '#aecdc7'
      },
      fontFamily: {
        'archivo': ['Archivo', 'sans-serif'],
        'open-sans': ['Open Sans', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'fade-in-slow': 'fadeIn 2s ease-in-out',
        'fade-in-pop': 'fadeIn 0.5s ease-in-out, pop 0.5s ease-in-out',
        'fade-in-pop-fast': 'fadeIn 0.2s ease-in-out, pop 0.2s ease-in-out',
        'in-sub-content': 'inSubContent 1s ease-in-out, fadeIn 2s ease',
        'in-sub-content-slow': 'inSubContent 2s ease-in-out, fadeIn 5s ease',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pop: {
          '0%': { transform: 'scale(0.75)' },
          '100%': { transform: 'scale(1)' },
        },
        inSubContent: {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        }
      },
    },
  },
  plugins: [],
}