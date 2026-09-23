interface MarkProps {
  cli: string;
  accent: string;
  className?: string;
}

/** Simple per-CLI glyphs (no third-party logos), tinted with the CLI accent. */
export function AgentMark({ cli, accent, className }: MarkProps) {
  const common = { className, viewBox: '0 0 16 16', fill: 'none', stroke: accent, strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (cli) {
    case 'claude':
      return (
        <svg {...common}>
          <path d="M8 2v12M2.8 5l10.4 6M13.2 5L2.8 11" />
        </svg>
      );
    case 'codex':
      return (
        <svg {...common}>
          <path d="M8 2.2a5.8 5.8 0 1 1-4.4 2L8 8l2.6 3.4A5.8 5.8 0 0 0 8 2.2Z" />
        </svg>
      );
    case 'cursor':
      return (
        <svg {...common}>
          <path d="M8 1.8 14 5v6l-6 3.2L2 11V5l6-3.2Z" />
          <path d="M2 5l6 3.2L14 5M8 8.2V14" />
        </svg>
      );
    case 'devin':
      return (
        <svg {...common}>
          <path d="M4.6 11.4a2.7 2.7 0 0 1 .3-5.4 3.3 3.3 0 0 1 6.3.6 2.5 2.5 0 0 1-.4 4.8H4.6Z" />
        </svg>
      );
    case 'grok':
      return (
        <svg {...common}>
          <path d="M3 3l10 10M13 3L8.4 8.6M6.2 12.4 3 13l.6-3.2" />
        </svg>
      );
    case 'pi':
      return (
        <svg {...common}>
          <path d="M3 5.2h10M5.4 5.2V12M10.6 5.2V12" />
        </svg>
      );
    case 'opencode':
      return (
        <svg {...common}>
          <path d="M5.6 4 2.8 8l2.8 4M10.4 4l2.8 4-2.8 4" />
        </svg>
      );
    case 'gemini':
      return (
        <svg {...common}>
          <path d="M8 1.8c.8 3.2 2.2 4.6 5.4 5.4-3.2.8-4.6 2.2-5.4 5.4-.8-3.2-2.2-4.6-5.4-5.4C5.8 6.4 7.2 5 8 1.8Z" />
        </svg>
      );
    case 'cline':
      return (
        <svg {...common}>
          <path d="M3 10.5 6 5l2.5 4L10.5 6l2.5 5.5H3Z" />
        </svg>
      );
    case 'commandcode':
      return (
        <svg {...common}>
          <path d="M4.5 3.5 9 8l-4.5 4.5M10.5 12.5H14" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M3.4 4.2 7 8l-3.6 3.8M8.6 12h4" />
        </svg>
      );
  }
}
