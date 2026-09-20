/**
 * The oversized "M." letterform used behind the login card: a heavy geometric M plus the accent-coloured full stop
 * (mirrors the "A." on the Argus login). Colours come from theme tokens, so it re-tints with every theme.
 */
export function BigM({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 800 640" className={className} style={style} role="img" aria-label="Mneme" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="mLetter" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="var(--letter)" />
          <stop offset="1" stopColor="var(--letter)" stopOpacity="0.86" />
        </linearGradient>
        <linearGradient id="mDot" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <polygon fill="url(#mLetter)" points="0,640 0,0 135,0 300,330 465,0 600,0 600,640 478,640 478,235 327,520 273,520 122,235 122,640" />
      <circle cx="728" cy="572" r="68" fill="url(#mDot)" />
    </svg>
  )
}
