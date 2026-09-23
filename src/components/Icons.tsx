import type { HarnessId } from '../lib/types';

type P = { size?: number; className?: string };

/** Harness marks. Simple, recognisable glyphs drawn here (no vendor logo files). */
export function HarnessIcon({ id, size = 18, className }: P & { id: HarnessId | 'native' | string }) {
  const s = { width: size, height: size, className, viewBox: '0 0 24 24', 'aria-hidden': true } as const;
  switch (id) {
    case 'claude':
      return (
        <svg {...s}>
          <g stroke="#D97757" strokeWidth="2.3" strokeLinecap="round">
            {Array.from({ length: 10 }, (_, i) => {
              const a = (i / 10) * Math.PI * 2;
              const r1 = 2.2;
              const r2 = i % 2 ? 8.2 : 9.8;
              return <line key={i} x1={12 + Math.cos(a) * r1} y1={12 + Math.sin(a) * r1} x2={12 + Math.cos(a) * r2} y2={12 + Math.sin(a) * r2} />;
            })}
          </g>
        </svg>
      );
    case 'codex':
      return (
        <svg {...s}>
          <g fill="none" stroke="currentColor" strokeWidth="1.5">
            {[0, 60, 120].map(r => (
              <ellipse key={r} cx="12" cy="12" rx="9" ry="4.2" transform={`rotate(${r} 12 12)`} />
            ))}
          </g>
        </svg>
      );
    case 'pi':
      return (
        <svg {...s}>
          <rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="none" stroke="#a78bfa" strokeWidth="1.6" />
          <path d="M7 9h10M9.6 9v7.5M14.4 9v5.8c0 1 .5 1.7 1.6 1.7" fill="none" stroke="#a78bfa" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'devin':
      return (
        <svg {...s}>
          <path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z" fill="none" stroke="#5eead4" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M9 8.5h2.6a3.5 3.5 0 0 1 0 7H9z" fill="none" stroke="#5eead4" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      );
    case 'native':
      return (
        <svg {...s}>
          <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2.4" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m7.5 9.5 3 2.5-3 2.5M12.5 15h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

function base({ size = 18, className }: P) {
  return {
    width: size,
    height: size,
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
}

export const Icon = {
  Logo: ({ size = 22 }: P) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="bm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f5b83d" />
          <stop offset="1" stopColor="#4f7cff" />
        </linearGradient>
      </defs>
      <path d="M13.8 1.8 4.6 13.4h6.1l-1.9 8.8 10.6-12.6h-6.3z" fill="url(#bm-g)" />
    </svg>
  ),
  SidebarLeft: (p: P) => (
    <svg {...base(p)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </svg>
  ),
  SidebarRight: (p: P) => (
    <svg {...base(p)}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5v15" />
    </svg>
  ),
  Grid: (p: P) => (
    <svg {...base(p)}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </svg>
  ),
  Bell: (p: P) => (
    <svg {...base(p)}>
      <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </svg>
  ),
  Plus: (p: P) => (
    <svg {...base(p)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Chevron: (p: P) => (
    <svg {...base(p)}>
      <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
    </svg>
  ),
  More: (p: P) => (
    <svg {...base(p)}>
      <circle cx="6" cy="12" r=".9" fill="currentColor" />
      <circle cx="12" cy="12" r=".9" fill="currentColor" />
      <circle cx="18" cy="12" r=".9" fill="currentColor" />
    </svg>
  ),
  Expand: (p: P) => (
    <svg {...base(p)}>
      <path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13.5 10.5M4.5 19.5l6-6" />
    </svg>
  ),
  Collapse: (p: P) => (
    <svg {...base(p)}>
      <path d="M19.5 10H14V4.5M4.5 14H10v5.5M14 10l5.5-5.5M10 14l-5.5 5.5" />
    </svg>
  ),
  Close: (p: P) => (
    <svg {...base(p)}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </svg>
  ),
  Moon: (p: P) => (
    <svg {...base(p)}>
      <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />
    </svg>
  ),
  Sun: (p: P) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.5v1.8M12 18.7v1.8M20.5 12h-1.8M5.3 12H3.5M18 6l-1.3 1.3M7.3 16.7 6 18M18 18l-1.3-1.3M7.3 7.3 6 6" />
    </svg>
  ),
  Gear: (p: P) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
    </svg>
  ),
  Layout: (p: P) => (
    <svg {...base(p)}>
      <rect x="4" y="3.5" width="16" height="7" rx="1.6" />
      <rect x="4" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="14" y="13.5" width="6" height="7" rx="1.6" />
    </svg>
  ),
  Agents: (p: P) => (
    <svg {...base(p)}>
      <rect x="3.5" y="4" width="10" height="7" rx="1.6" />
      <rect x="10.5" y="13" width="10" height="7" rx="1.6" />
      <path d="M8.5 11v5h2" />
    </svg>
  ),
  Eye: (p: P) => (
    <svg {...base(p)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  EyeOff: (p: P) => (
    <svg {...base(p)}>
      <path d="M3.5 3.5l17 17M10 5.8A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.3 7.3C3.9 9 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.6 9.6 0 0 0 4.3-1" />
    </svg>
  ),
  Stop: (p: P) => (
    <svg {...base(p)}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    </svg>
  ),
  Send: (p: P) => (
    <svg {...base(p)}>
      <path d="M5 12h13M13 6.5 18.5 12 13 17.5" />
    </svg>
  ),
  Branch: (p: P) => (
    <svg {...base(p)}>
      <circle cx="7" cy="6" r="2" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="8" r="2" />
      <path d="M7 8v8M17 10c0 4-10 2-10 6" />
    </svg>
  ),
  Check: (p: P) => (
    <svg {...base(p)}>
      <path d="m5.5 12.5 4 4 9-9" />
    </svg>
  ),
  Folder: (p: P) => (
    <svg {...base(p)}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  ),
  Copy: (p: P) => (
    <svg {...base(p)}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </svg>
  ),
};
