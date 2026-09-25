import { useSettings } from '@/contexts/SettingsContext'
import { useToast } from '@/contexts/ToastContext'
import { THEMES, type ThemePref } from '@/lib/themes'

/** The theme grid: colour themes (plus "Match my device") and platform styles. Applies instantly and saves. */
export function ThemePicker() {
  const { theme, update } = useSettings()
  const { toast } = useToast()
  const setTheme = (t: ThemePref) => void update({ theme: t }).catch(() => toast('Couldn’t save the theme.', { kind: 'error' }))
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Theme">
        <button role="radio" aria-checked={theme === 'system'} onClick={() => setTheme('system')}
          className={`group rounded-2xl border p-3 text-left ${theme === 'system' ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'}`}>
          <span className="mb-2.5 flex h-14 overflow-hidden rounded-xl border border-line">
            <span className="flex-1" style={{ background: 'linear-gradient(135deg,#e3e8fb,#f5f7fd)' }} />
            <span className="flex-1" style={{ background: 'linear-gradient(135deg,#2a1745,#120c1e)' }} />
          </span>
          <span className="block text-sm font-semibold">Match my device</span>
          <span className="block text-xs text-muted">Light by day, dark by night</span>
        </button>
        {THEMES.filter((t) => !t.platform).map((t) => (
          <button key={t.id} role="radio" aria-checked={theme === t.id} onClick={() => setTheme(t.id)}
            className={`group rounded-2xl border p-3 text-left ${theme === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'}`}>
            <span className="mb-2.5 flex h-14 items-end justify-end overflow-hidden rounded-xl border border-line p-2" style={{ background: `radial-gradient(90px 60px at 15% 0%, ${t.swatch[1]}55, transparent 70%), ${t.swatch[0]}` }}>
              <span className="size-5 rounded-full shadow-lg" style={{ background: t.swatch[1], boxShadow: `0 4px 14px ${t.swatch[1]}88` }} />
            </span>
            <span className="block text-sm font-semibold">{t.label}</span>
            <span className="block text-xs text-muted">{t.blurb}</span>
          </button>
        ))}
      </div>
      <h3 className="label-caps mb-3 mt-6">Platform</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Platform theme">
        {THEMES.filter((t) => t.platform).map((t) => {
          const p = t.platform!
          return (
            <button key={t.id} role="radio" aria-checked={theme === t.id} onClick={() => setTheme(t.id)}
              className={`group rounded-2xl border p-3 text-left ${theme === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover'}`}>
              {/* a tiny window in the platform's own shape: its font, corners and accent */}
              <span className="mb-2.5 flex h-14 items-center gap-2 overflow-hidden rounded-xl border border-line px-2.5" style={{ background: t.swatch[0], fontFamily: p.font }} aria-hidden>
                <span className="flex flex-1 items-center gap-1.5 px-2 py-1.5" style={{ background: p.surface, color: p.ink, borderRadius: p.radius }}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: t.swatch[1] }} />
                  <span className="truncate text-xs font-semibold">Aa</span>
                </span>
                <span className="h-5 w-8 shrink-0" style={{ background: t.swatch[1], borderRadius: p.radius < 8 ? p.radius : 999 }} />
              </span>
              <span className="block text-sm font-semibold">{t.label}</span>
              <span className="block text-xs text-muted">{t.blurb}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}
