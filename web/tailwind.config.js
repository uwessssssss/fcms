/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    container: {
      center: true,
      padding: '1rem',
    },
    extend: {
      colors: {
        background: { DEFAULT: 'var(--background)' },
        foreground: { DEFAULT: 'var(--foreground)' },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        border: { DEFAULT: 'var(--border)' },
        input: { DEFAULT: 'var(--input)' },
        ring: { DEFAULT: 'var(--ring)' },
        status: {
          active: 'var(--status-active)',
          idle: 'var(--status-idle)',
          fault: 'var(--status-fault)',
          offline: 'var(--status-offline)',
          maintenance: 'var(--status-maintenance)',
        },
        tank: {
          normal: 'var(--tank-normal)',
          low: 'var(--tank-low)',
          critical: 'var(--tank-critical)',
          replenishing: 'var(--tank-replenishing)',
        },
        'card-elevated': { DEFAULT: 'var(--card-elevated)' },
        'border-subtle': { DEFAULT: 'var(--border-subtle)' },
        'input-hover': { DEFAULT: 'var(--input-hover)' },
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'calc(var(--radius) - 4px)',
        md: 'var(--radius)',
        lg: 'calc(var(--radius) + 2px)',
        xl: 'calc(var(--radius) + 6px)',
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'DM Sans', 'var(--font-geist-sans)', 'sans-serif'],
        mono: ['JetBrains Mono', 'var(--font-geist-mono)', 'monospace'],
      },
      boxShadow: {
        'glow-sm': '0 0 0 1px rgba(0,212,160,0.15), 0 2px 12px rgba(0,212,160,0.1)',
        'glow-md': '0 0 0 1px rgba(0,212,160,0.2), 0 4px 24px rgba(0,212,160,0.12)',
        'premium': '0 4px 20px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3)',
        'premium-lg': '0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
      },
      animation: {
        'shimmer': 'shimmer 1.5s infinite',
        'pulse-dot': 'pulse-dot 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slide-up 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'fade-in': 'fade-in 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};