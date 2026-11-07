// Serve "Boston Night" Tailwind preset.
// Usage (tailwind.config.js):  presets: [require('./design/serve/tailwind.preset.js')]
// Keep tokens.css imported too: it holds the keyframes, glass card and hero classes.

module.exports = {
  theme: {
    extend: {
      colors: {
        night: {
          950: '#0b1220',
          900: '#111827',
          850: '#141d2e',
          800: '#1f2937',
          700: '#24304a',
          600: '#2a3550',
        },
        dusk: '#3a3a4a',
        gold: { DEFAULT: '#c9a96e', ink: '#8a6d3b' },
        cream: { DEFAULT: '#f7f4ee', line: '#e7e1d4' },
        live: '#4ade80',
      },
      fontFamily: {
        display: ['"Times New Roman"', 'Times', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: { card: '14px', glass: '20px', ctl: '10px' },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,.1), 0 1px 2px rgba(0,0,0,.06)',
        float: '0 14px 34px rgba(0,0,0,.45)',
        glass: '0 40px 90px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06)',
        gold: '0 10px 24px rgba(201,169,110,.25)',
      },
      letterSpacing: { eyebrow: '.32em' },
      maxWidth: { page: '1120px' },
      keyframes: {
        drift: { from: { left: '-260px' }, to: { left: '100%' } },
        sail: { from: { left: '-120px' }, to: { left: '100%' } },
        'sail-back': { from: { left: '100%' }, to: { left: '-120px' } },
        bob: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-10px)' } },
        rock: { '0%,100%': { transform: 'translateY(0) rotate(-2deg)' }, '50%': { transform: 'translateY(-3px) rotate(2deg)' } },
        twinkle: { '0%,100%': { opacity: '.15' }, '50%': { opacity: '.9' } },
        rise: { from: { opacity: '0', transform: 'translateY(14px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        rise: 'rise .5s ease-out both',
        rock: 'rock 4.5s ease-in-out infinite',
      },
    },
  },
};
