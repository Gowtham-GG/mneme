import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ThemePicker } from './ThemePicker'
import {
  IconBoard, IconCompass, IconHabit, IconInbox, IconLink, IconMore, IconPalette, IconPlus, IconSteps, IconTag, IconTasks, IconX,
} from './icons'

// A walk around the app: a small card that moves page to page and rings the part it talks about.
// Opens once on a new device; again any time from More → Tour or the command palette.

const SEEN = 'mneme-tour-seen'
const OPEN_EVENT = 'mneme:tour'
// eslint-disable-next-line react-refresh/only-export-components
export const openTour = () => window.dispatchEvent(new Event(OPEN_EVENT))

interface Step {
  to: string
  /** What to ring: the first of these selectors that's visible on screen. */
  spot?: string[]
  icon: ComponentType<{ size?: number }>
  title: string
  lines: ReactNode[]
  /** Things to try typing. */
  syntax?: [string, string][]
  extra?: ReactNode
  wide?: boolean
}

const dock = (href: string) => `nav[aria-label="Primary"] a[href="${href}"]`
const MORE = 'nav[aria-label="Primary"] button[aria-label="More"]'
const k = (s: string) => <kbd className="rounded border border-line bg-panel px-1 font-mono text-[11px]">{s}</kbd>

/** How the board draws each kind of connection. */
function ArrowLegend() {
  const row = (label: string, stroke: string, dash?: string, head?: boolean) => (
    <span className="flex items-center gap-2">
      <svg width="34" height="10" className="shrink-0 overflow-visible" aria-hidden>
        <line x1="1" y1="5" x2={head ? 27 : 33} y2="5" style={{ stroke }} strokeWidth="2" strokeDasharray={dash} />
        {head && <path d="M27 1.5 34 5 27 8.5z" style={{ fill: stroke }} />}
      </svg>
      {label}
    </span>
  )
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-panel px-3 py-2 text-xs text-muted">
      {row('Subtask', 'var(--faint)')}
      {row('Next step', 'var(--accent)', undefined, true)}
      {row('Waits for', 'var(--important)', '6 4', true)}
      {row('Related', 'var(--faint)', '2 4')}
    </div>
  )
}

const STEPS: Step[] = [
  {
    to: '/', icon: IconCompass, title: 'Welcome to Mneme.',
    lines: ['Your second memory: capture fast, sort later, find anything.', 'Two minutes. Skip any time — it lives in More → Tour.'],
    extra: (
      <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
        {['Capture', 'Process', 'Connect', 'Find'].map((w, i) => (
          <span key={w} className="flex items-center gap-1.5">{i > 0 && <span className="text-faint">→</span>}<span className="rounded-full bg-accent-soft px-2.5 py-1 text-accent">{w}</span></span>
        ))}
      </div>
    ),
  },
  {
    to: '/', spot: ['[data-tour="capture"]', 'nav[aria-label="Primary"] button[aria-label^="Capture"]'], icon: IconPlus, title: 'Capture',
    lines: [
      'Type anything in the box on Today — no title, no folder.',
      <>From anywhere: the ＋ in the dock, or press {k('C')}. {k('Ctrl')}+{k('Enter')} saves.</>,
    ],
    syntax: [['#tag', 'tag it'], ['- [ ] Call bank', 'a task'], ['[[Note title]]', 'link a note'], ['? why…', 'a question'], ['! urgent', 'important']],
  },
  {
    to: '/inbox', spot: [dock('/inbox'), MORE], icon: IconInbox, title: 'Process',
    lines: [
      'New notes wait here. Go through them one at a time.',
      <>{k('1')}–{k('5')} set a type · {k('T')} tag · {k('A')} archive · {k('J')} skip.</>,
      'Optional — nothing breaks if you never do it.',
    ],
  },
  {
    to: '/notes', spot: [dock('/notes')], icon: IconTag, title: 'Connect & find',
    lines: [
      <>#tags build the Index (nest them: <code className="text-accent">#java/jvm</code>).</>,
      'A [[link]] or an N-… id joins two notes; the other one lists it under Referenced by.',
      <>Find anything: {k('/')} search, {k('Ctrl')}+{k('K')} jump.</>,
    ],
  },
  {
    to: '/tasks', spot: [dock('/tasks')], icon: IconTasks, title: 'Tasks.',
    lines: [
      <>Write <code className="text-accent">- [ ] thing</code> in any note — it’s a task, ticked in either place.</>,
      'Or add one here. Give it a date, priority and status: open, in progress, on hold, done, cancelled.',
      'Today shows only what you can act on now.',
    ],
  },
  {
    to: '/tasks', icon: IconSteps, title: 'Subtasks & sequences',
    lines: [
      <>{'⋯'} → <b>Subtask</b>: split a task into pieces.</>,
      <>{'⋯'} → <b>Sequence</b>: ordered steps — each is locked until the one before is done.</>,
      'In a note: indent = subtask, 1. 2. 3. = sequence.',
      'A parent finishes when its children do; a later child date pushes the parent’s.',
    ],
  },
  {
    to: '/tasks', icon: IconLink, title: 'Links & references',
    lines: [
      <><b>Waits for…</b> — stays Blocked until the other task is done.</>,
      <><b>Related…</b> — a plain reference; changes nothing.</>,
      <><b>Copy link</b>, then paste <code className="text-accent">[[T-…]]</code> into a note to point at a task.</>,
      <>Flip, change or remove any link: {'⋯'} → Links.</>,
    ],
  },
  {
    to: '/tasks/board', spot: ['[role="tablist"][aria-label="Canvases"]', 'nav[aria-label="Tasks view"]'], icon: IconBoard, title: 'Board',
    lines: [
      'Canvases group main tasks (one can be on several). Drag the tabs to reorder.',
      'Drag boxes around. Drag a box’s dot onto another to connect; tap an arrow to change it.',
      <>Tap a task to light up its chain. <b>Tidy</b> lays it all out neatly.</>,
    ],
    extra: <ArrowLegend />,
  },
  {
    to: '/habits', icon: IconHabit, title: 'Habits',
    lines: [
      'Yes/no or counted, every day or on chosen weekdays.',
      'Tick them from the chips under the capture box on Today.',
      'Heatmap, streaks and your 30-day rate live here.',
    ],
  },
  {
    to: '/', spot: [MORE], icon: IconMore, title: 'And more',
    lines: [
      <>{k('J')} today’s journal page · {k('?')} all shortcuts.</>,
      'Passwords: an encrypted vault, unlocked only on your device.',
      'Works offline and installs as an app. Export everything any time (Settings).',
    ],
  },
  {
    to: '/', icon: IconPalette, title: 'Pick your look', wide: true,
    lines: ['Tap one to try it. Change it any time in Settings.'],
    extra: <div className="max-h-[42vh] overflow-y-auto pr-1 lg:max-h-[50vh]"><ThemePicker /></div>,
  },
]

/** A pulsing ring around the first visible match, following it as the page settles. */
function Spotlight({ selectors }: { selectors?: string[] }) {
  const [r, setR] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!selectors?.length) return
    const find = () => {
      for (const s of selectors) {
        for (const el of document.querySelectorAll<HTMLElement>(s)) {
          const b = el.getBoundingClientRect()
          if (b.width > 0 && b.height > 0) { setR(b); return }
        }
      }
      setR(null)
    }
    find()
    const t = window.setInterval(find, 300)
    return () => { window.clearInterval(t); setR(null) }
  }, [selectors])
  if (!selectors?.length || !r) return null
  const pad = 6
  return (
    <div aria-hidden className="pointer-events-none fixed z-[44] rounded-2xl ring-2 ring-accent transition-all duration-300"
      style={{ left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2, boxShadow: '0 0 0 4px var(--accent-soft), 0 0 30px var(--accent-glow)' }}>
      <span className="absolute inset-0 animate-ping rounded-2xl ring-2 ring-accent/40" />
    </div>
  )
}

export function Tour() {
  const [step, setStep] = useState<number | null>(null)
  const nav = useNavigate()
  const loc = useLocation()

  useEffect(() => {
    const open = () => setStep(0)
    window.addEventListener(OPEN_EVENT, open)
    let seen = true
    try { seen = !!localStorage.getItem(SEEN) } catch { /* private mode: don't nag */ }
    const t = seen ? 0 : window.setTimeout(open, 700)
    return () => { window.removeEventListener(OPEN_EVENT, open); window.clearTimeout(t) }
  }, [])

  const s = step === null ? null : STEPS[step]
  // each step shows its page behind the card
  useEffect(() => { if (s && loc.pathname !== s.to) nav(s.to) }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!s || step === null) return null
  const close = () => { try { localStorage.setItem(SEEN, '1') } catch { /* ignore */ } setStep(null) }
  const last = step === STEPS.length - 1

  return (
    <>
      <Spotlight selectors={s.spot} />
      <section role="dialog" aria-label={`Tour: ${s.title}`} aria-live="polite"
        className={`glass-strong pop fixed inset-x-3 bottom-[calc(max(1rem,env(safe-area-inset-bottom))+4.5rem)] z-[45] max-h-[70vh] overflow-y-auto rounded-2xl p-4 lg:inset-x-auto lg:bottom-auto lg:right-6 lg:top-20 ${s.wide ? 'lg:w-[560px]' : 'lg:w-[400px]'}`}
        key={step}>
        <div className="mb-3 flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><s.icon size={22} /></span>
          <div className="min-w-0 flex-1">
            <p className="label-caps">{step + 1} of {STEPS.length}</p>
            <h2 className="text-lg font-semibold leading-tight">{s.title}</h2>
          </div>
          <button aria-label="Close the tour" className="rounded-lg p-1 text-faint hover:bg-hover hover:text-ink" onClick={close}><IconX size={18} /></button>
        </div>
        <ul className="mb-3 grid gap-1.5 text-sm leading-snug text-muted">
          {s.lines.map((l, i) => <li key={i} className="flex gap-2"><span className="mt-[7px] size-1 shrink-0 rounded-full bg-accent" />{l}</li>)}
        </ul>
        {s.syntax && (
          <div className="mb-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 rounded-xl bg-panel px-3 py-2 text-xs">
            {s.syntax.map(([code, what]) => (
              <span key={code} className="contents"><code className="font-mono text-accent">{code}</code><span className="text-muted">{what}</span></span>
            ))}
          </div>
        )}
        {s.extra && <div className="mb-3">{s.extra}</div>}
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1" aria-hidden>
            {STEPS.map((_, i) => <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-4 bg-accent' : 'w-1.5 bg-line'}`} />)}
          </div>
          <div className="flex items-center gap-1.5">
            {step > 0 && <button className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink" onClick={() => setStep(step - 1)}>Back</button>}
            {!last && step === 0 && <button className="rounded-lg px-3 py-1.5 text-sm text-muted hover:bg-hover hover:text-ink" onClick={close}>Skip</button>}
            <button className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-on-accent" onClick={() => (last ? close() : setStep(step + 1))}>
              {last ? 'Start' : step === 0 ? 'Show me' : 'Next'}
            </button>
          </div>
        </div>
      </section>
    </>
  )
}
