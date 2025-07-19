/** @type {import('tailwindcss').Config} */
export default {
  // add .svelte files to use tailwind
  content: ['./src/**/*.svelte'],
  theme: {
    extend: {
      colors: {
        accent: '#428a91',
        'accent-dark': '#2d626a',
        'accent-light': '#B0DFD5',
        'accent-lighter': '#e1f4f0',
        'accent-text-color': '#000000',
        'background-color': '#F7FFFD',
      },
      fontFamily: {
        archivo: ['Archivo', 'sans-serif'],
        'open-sans': ['Open Sans', 'sans-serif'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in-out',
        'fade-in-slow': 'fadeIn 2s ease-in-out',
        'fade-in-pop': 'fadeIn 0.5s ease-in-out, pop 0.5s ease-in-out',
        'fade-in-pop-fast': 'fadeIn 0.2s ease-in-out, pop 0.2s ease-in-out',
        'in-sub-content': 'inSubContent 1s ease-in-out, fadeIn 2s ease',
        'in-sub-content-slow': 'inSubContent 2s ease-in-out, fadeIn 5s ease',
        'slide-up': 'slideUp 0.4s ease-out',
        'slide-down': 'slideDown 0.4s ease-out',
        'slide-left': 'slideLeft 0.4s ease-out',
        'slide-right': 'slideRight 0.4s ease-out',
        'bounce-in': 'bounceIn 0.6s ease-out',
        'scale-in': 'scaleIn 0.3s ease-out',
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
        },
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideDown: {
          '0%': { transform: 'translateY(-20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        slideLeft: {
          '0%': { transform: 'translateX(20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        slideRight: {
          '0%': { transform: 'translateX(-20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        bounceIn: {
          '0%': { transform: 'scale(0.3)', opacity: '0' },
          '50%': { transform: 'scale(1.05)' },
          '70%': { transform: 'scale(0.9)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        scaleIn: {
          '0%': { transform: 'scale(0.8)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
