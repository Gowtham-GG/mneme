import { estimateStrength } from '@/lib/vaultCrypto'

const COLORS = ['bg-danger', 'bg-danger', 'bg-important', 'bg-task', 'bg-task']

/** Five-segment strength bar + label. It is an estimate for guidance, not a guarantee. */
export function StrengthMeter({ password, hint }: { password: string; hint?: string }) {
  const s = estimateStrength(password)
  const filled = password ? s.score + 1 : 0 // "Very weak" still shows one red segment
  return (
    <div aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => <span key={i} className={`h-1.5 flex-1 rounded-full ${i < filled ? COLORS[s.score] : 'bg-hover'}`} />)}
      </div>
      <p className="mt-1.5 text-xs text-muted">{password ? <><b className="font-semibold text-ink">{s.label}</b> · ~{s.bits} bits{hint ? ` · ${hint}` : ''}</> : (hint ?? ' ')}</p>
    </div>
  )
}
