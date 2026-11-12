// A small hand-drawn icon set on a 24×24 grid. Stroke icons follow
// currentColor; play, stop and more are filled.

const PATHS = {
  play: <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  restart: (
    <>
      <path d="M15.75 18.5A7.5 7.5 0 1 1 15.75 5.5" />
      <path d="M11.8 5.85L15.75 5.5L14.05 1.9" />
    </>
  ),
  open: (
    <>
      <path d="M14 5h5v5" />
      <path d="M19 5l-8 8" />
      <path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  chevronDown: <path d="M7 10l5 5 5-5" />,
  chevronRight: <path d="M10 7l5 5-5 5" />,
  folder: <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  terminal: (
    <>
      <path d="M5 8l4 4-4 4" />
      <path d="M12 16h7" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  plus: <path d="M12 5v14M5 12h14" />,
  warning: (
    <>
      <path d="M12 4.5l8.5 15h-17z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.9" r="0.4" fill="currentColor" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.4" fill="currentColor" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  branch: (
    <>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="7" r="2" />
      <path d="M7 8v8M17 9v1a4 4 0 0 1-4 4h-2.5A3.5 3.5 0 0 0 7 16" />
    </>
  ),
  machine: (
    <>
      <rect x="4" y="4.5" width="16" height="6" rx="1.5" />
      <rect x="4" y="13.5" width="16" height="6" rx="1.5" />
      <path d="M7.5 7.5h.01M7.5 16.5h.01" />
    </>
  ),
  plug: (
    <>
      <path d="M9 4v4M15 4v4" />
      <path d="M6.5 8h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16.5V20" />
    </>
  ),
  pencil: (
    <>
      <path d="M15.5 5.5l3 3L9 18H6v-3z" />
      <path d="M13.5 7.5l3 3" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14" />
      <path d="M10 4.5h4" />
      <path d="M7 7l.8 11a1.5 1.5 0 0 0 1.5 1.5h5.4a1.5 1.5 0 0 0 1.5-1.5L17 7" />
      <path d="M10.5 11v5M13.5 11v5" />
    </>
  ),
  file: (
    <>
      <path d="M7 3.5h6.5L18.5 8.5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13 3.5V9h5.5" />
    </>
  ),
  shield: <path d="M12 3.5l7 2.5v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z" />,
  wand: (
    <>
      <path d="M5 19L15 9" />
      <path d="M14 5.5V3.5M18.5 10h2M17.2 6.8l1.4-1.4M14 5.5l1 1M18.5 10l-1-1" />
    </>
  ),
  apps: (
    <>
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.5" />
    </>
  ),
  box: (
    <>
      <path d="M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5z" />
      <path d="M4.5 7.75L12 12l7.5-4.25M12 12v8.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c-2.4 2.5-3.5 5.3-3.5 8.5s1.1 6 3.5 8.5M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 4l8.5 4.25L12 12.5 3.5 8.25z" />
      <path d="M3.5 12.25L12 16.5l8.5-4.25" />
      <path d="M3.5 16.25L12 20.5l8.5-4.25" />
    </>
  ),
  pulse: <path d="M3.5 12.5h3.75l2.25-5.5 4 11 2.5-5.5h4.5" />,
  gear: (
    <>
      <path d="M10.21 5.34L10.67 3.10L13.33 3.10L13.79 5.34A6.9 6.9 0 0 1 15.45 6.02L17.35 4.77L19.23 6.65L17.98 8.55A6.9 6.9 0 0 1 18.66 10.21L20.90 10.67L20.90 13.33L18.66 13.79A6.9 6.9 0 0 1 17.98 15.45L19.23 17.35L17.35 19.23L15.45 17.98A6.9 6.9 0 0 1 13.79 18.66L13.33 20.90L10.67 20.90L10.21 18.66A6.9 6.9 0 0 1 8.55 17.98L6.65 19.23L4.77 17.35L6.02 15.45A6.9 6.9 0 0 1 5.34 13.79L3.10 13.33L3.10 10.67L5.34 10.21A6.9 6.9 0 0 1 6.02 8.55L4.77 6.65L6.65 4.77L8.55 6.02A6.9 6.9 0 0 1 10.21 5.34Z" />
      <circle cx="12" cy="12" r="2.75" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  panelRight: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  jobs: (
    <>
      <path d="M4.5 7.5l1.5 1.5 2.5-3" />
      <path d="M4.5 16.5l1.5 1.5 2.5-3" />
      <path d="M11.5 7.5h8M11.5 16.5h8" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevronLeft: <path d="M14 7l-5 5 5 5" />,
  link: (
    <>
      <path d="M10.5 13.5a3.75 3.75 0 0 0 5.3 0l2.9-2.9a3.75 3.75 0 0 0-5.3-5.3l-.9.9" />
      <path d="M13.5 10.5a3.75 3.75 0 0 0-5.3 0l-2.9 2.9a3.75 3.75 0 0 0 5.3 5.3l.9-.9" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="6.5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.25l2.5 2.5 4.5-5" />
    </>
  ),
  xCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.25 9.25l5.5 5.5M14.75 9.25l-5.5 5.5" />
    </>
  ),
  minus: <path d="M7 12h10" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 3.5v1.75M12 18.75v1.75M3.5 12h1.75M18.75 12h1.75M6 6l1.25 1.25M16.75 16.75L18 18M6 18l1.25-1.25M16.75 7.25L18 6" />
    </>
  ),
  moon: <path d="M19 14.25A7.5 7.5 0 0 1 9.75 5 7.5 7.5 0 1 0 19 14.25z" />,
  monitor: (
    <>
      <rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" />
      <path d="M9 20h6M12 16v4" />
    </>
  ),
  rows: (
    <>
      <path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h15" />
    </>
  ),
  rowsCompact: (
    <>
      <path d="M4.5 5.5h15M4.5 9.5h15M4.5 13.5h15M4.5 17.5h15" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
