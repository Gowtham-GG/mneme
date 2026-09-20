import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_GEN, generatePassword, type GenOptions } from '@/lib/vaultCrypto'
import type { VaultItem } from '@/lib/vaultData'
import { Dialog } from '../Dialog'
import { IconEye, IconEyeOff, IconWand } from '../icons'
import { StrengthMeter } from './StrengthMeter'

export interface CredentialDraft { id?: string; site: string; username: string; password: string; notes: string }

/** Add / edit one login. Passwords can be generated here; nothing is saved (or even sent) until you press Save. */
export function CredentialDialog({ open, onClose, initial, sites, onSave, onDelete }: {
  open: boolean; onClose: () => void; initial: CredentialDraft | null; sites: string[]
  onSave: (d: CredentialDraft) => Promise<void>; onDelete?: (id: string) => void
}) {
  const [d, setD] = useState<CredentialDraft>({ site: '', username: '', password: '', notes: '' })
  const [show, setShow] = useState(false)
  const [gen, setGen] = useState<GenOptions>(DEFAULT_GEN)
  const [genOpen, setGenOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setD(initial ?? { site: '', username: '', password: '', notes: '' })
    setShow(false); setGenOpen(false); setErr(null); setBusy(false)
  }, [open, initial])

  const editing = !!initial?.id
  const set = <K extends keyof CredentialDraft>(k: K, v: CredentialDraft[K]) => setD((x) => ({ ...x, [k]: v }))
  const regenerate = (o: GenOptions = gen) => { set('password', generatePassword(o)); setShow(true) }
  const setOpt = (patch: Partial<GenOptions>) => { const o = { ...gen, ...patch }; setGen(o); regenerate(o) }
  const uniqueSites = useMemo(() => [...new Set(sites)].sort(), [sites])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!d.site.trim()) { setErr('Enter the website (or a name for this account).'); return }
    if (!d.username.trim() && !d.password) { setErr('Enter a username or a password.'); return }
    setBusy(true); setErr(null)
    try { await onSave(d); onClose() } catch (er) { setErr((er as Error).message || 'Couldn’t save.') } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onClose={onClose} title={editing ? 'Edit login' : 'Add login'}>
      <form onSubmit={submit} autoComplete="off" noValidate>
        <h2 className="mb-5 text-lg font-semibold">{editing ? 'Edit login' : 'Add a login'}</h2>

        <label className="label-caps mb-1.5 block" htmlFor="v-site">Website</label>
        <input id="v-site" list="v-sites" className="field mb-4" placeholder="github.com" value={d.site} onChange={(e) => set('site', e.target.value)} autoFocus={!editing}
          autoComplete="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
        <datalist id="v-sites">{uniqueSites.map((s) => <option key={s} value={s} />)}</datalist>

        <label className="label-caps mb-1.5 block" htmlFor="v-user">Username / email</label>
        <input id="v-user" className="field mb-4" value={d.username} onChange={(e) => set('username', e.target.value)}
          autoComplete="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" />

        <div className="mb-1.5 flex items-center justify-between">
          <label className="label-caps" htmlFor="v-pass">Password</label>
          <button type="button" className="inline-flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => { setGenOpen((v) => !v); if (!genOpen && !d.password) regenerate() }}>
            <IconWand size={14} /> {genOpen ? 'Hide generator' : 'Generate'}
          </button>
        </div>
        <div className="relative mb-2">
          <input id="v-pass" type={show ? 'text' : 'password'} className={`field pr-11 ${show ? 'font-mono text-[13px]' : ''}`} value={d.password} onChange={(e) => set('password', e.target.value)}
            autoComplete="new-password" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
          <button type="button" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={() => setShow((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-faint hover:text-ink">
            {show ? <IconEyeOff size={17} /> : <IconEye size={17} />}
          </button>
        </div>
        <StrengthMeter password={d.password} />

        {genOpen && (
          <div className="pop mt-3 rounded-xl border border-line bg-panel p-4">
            <div className="mb-3 flex items-center gap-3">
              <label htmlFor="v-len" className="text-sm text-muted">Length</label>
              <input id="v-len" type="range" min={8} max={64} value={gen.length} onChange={(e) => setOpt({ length: Number(e.target.value) })} className="flex-1 accent-[var(--accent)]" />
              <output className="w-8 text-right text-sm tabular-nums">{gen.length}</output>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {([['upper', 'A–Z'], ['lower', 'a–z'], ['digits', '0–9'], ['symbols', '!@#$']] as const).map(([k, l]) => (
                <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={gen[k]} onChange={(e) => setOpt({ [k]: e.target.checked })} className="accent-[var(--accent)]" />{l}</label>
              ))}
              <label className="col-span-2 flex items-center gap-2"><input type="checkbox" checked={gen.avoidAmbiguous} onChange={(e) => setOpt({ avoidAmbiguous: e.target.checked })} className="accent-[var(--accent)]" />Avoid look-alike characters (I l 1 O 0)</label>
            </div>
            <button type="button" className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover" onClick={() => regenerate()}>Regenerate</button>
          </div>
        )}

        <label className="label-caps mb-1.5 mt-5 block" htmlFor="v-notes">Notes <span className="normal-case tracking-normal text-faint">(optional, also encrypted)</span></label>
        <textarea id="v-notes" rows={3} className="field mb-4 resize-y" value={d.notes} onChange={(e) => set('notes', e.target.value)} autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" />

        {err && <p role="alert" className="mb-3 text-sm text-danger">{err}</p>}
        <div className="flex items-center gap-2">
          {editing && onDelete && <button type="button" className="rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger-soft" onClick={() => onDelete(initial!.id!)}>Delete</button>}
          <span className="flex-1" />
          <button type="button" className="rounded-lg px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
          <button disabled={busy} className="bg-accent rounded-lg px-5 py-2 text-sm font-semibold text-on-accent">{busy ? 'Encrypting…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  )
}

export const draftFromItem = (i: VaultItem): CredentialDraft => ({ id: i.id, site: i.site, username: i.username, password: i.password, notes: i.notes })
