/** @type {import('tailwindcss').Config} */
export default {
  content: ['./app/index.html', './app/js/**/*.js'],
  theme: {
    extend: {
      borderRadius: {
        shell: '3px',
      },
      colors: {
        surface: 'var(--bg)',
        elev: 'var(--bg-elev)',
        panel: 'var(--bg-panel)',
        hover: 'var(--bg-hover)',
        border: 'var(--border)',
        'border-light': 'var(--border-light)',
        ink: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: 'var(--accent)',
        up: 'var(--green)',
        down: 'var(--red)',
        'accent-soft': 'var(--accent-soft)',
        'sb-fade': 'var(--sb-fade)',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        header: '0 1px 0 var(--border)',
        accentglow: '0 0 14px var(--accent-glow)',
        panel: '0 10px 28px rgba(0, 0, 0, 0.22)',
        'panel-light': '0 10px 28px rgba(15, 25, 35, 0.12)',
        sbthumb: '0 0 8px var(--accent-glow)',
      },
      minHeight: {
        touch: '44px',
      },
    },
  },
  plugins: [],
};
