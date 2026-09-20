import { useState } from 'react'
import { useVault } from '@/contexts/VaultContext'
import { masterPassphraseProblem } from '@/lib/vaultCrypto'
import { Card } from '../Card'
import { Dialog } from '../Dialog'
import { IconEye, IconEyeOff, IconLock } from '../icons'
import { StrengthMeter } from './StrengthMeter'

function PassInput({ id, value, onChange, label, autoFocus }: { id: string; value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean }) {
  const [show, setShow] = useState(false)
  return (
    <>
      <label className="label-caps mb-1.5 block" htmlFor={id}>{label}</label>
      <div className="relative mb-4">
        <input id={id} type={show ? 'text' : 'password'} className="field pr-11" value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}
          autoComplete="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
        <button type="button" aria-label={show ? 'Hide' : 'Show'} aria-pressed={show} onClick={() => setShow((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-faint hover:text-ink">
          {show ? <IconEyeOff size={17} /> : <IconEye size={17} />}
        </button>
      </div>
    </>
  )
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="h-full overflow-y-auto">
    <div className="page-top mx-auto max-w-md px-4 pb-32 lg:px-6 lg:pb-8">{children}</div>
  </div>
)

/** First run: create the vault. The passphrase is never sent anywhere; it only derives the encryption key. */
export function SetupScreen() {
  const { createVault } = useVault()
  const [p1, setP1] = useState('')
  const [p2, setP2] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const problem = p1 ? masterPassphraseProblem(p1) : null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (masterPassphraseProblem(p1)) { setErr(masterPassphraseProblem(p1)); return }
    if (p1 !== p2) { setErr('The two passphrases don’t match.'); return }
    setBusy(true); setErr(null)
    try { await createVault(p1) } catch (er) { setErr((er as Error).message) } finally { setBusy(false) }
  }

  return (
    <Shell>
      <div className="rise mb-6 text-center">
        <span className="bg-accent mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl text-on-accent"><IconLock size={26} /></span>
        <h1 className="text-[28px] font-bold leading-tight">Passwords<span className="text-accent">.</span></h1>
        <p className="mt-2 text-sm text-muted">An encrypted vault for your logins. Only you can read it.</p>
      </div>
      <Card>
        <form onSubmit={submit} autoComplete="off">
          <h2 className="mb-3 text-base font-semibold">Create your master passphrase</h2>
          <ul className="mb-5 list-disc space-y-1.5 pl-5 text-sm text-muted">
            <li>Everything is encrypted <b className="text-ink">in your browser</b> before it is saved. The server (and Supabase) only ever stores scrambled data.</li>
            <li>The passphrase is <b className="text-ink">never stored or sent</b> — so it <b className="text-danger">cannot be recovered</b> if you forget it.</li>
            <li>Choose a phrase of 4–5 unrelated words, and keep a copy somewhere safe (on paper is fine).</li>
          </ul>
          <PassInput id="mp1" label="Master passphrase" value={p1} onChange={setP1} autoFocus />
          <div className="-mt-2 mb-4"><StrengthMeter password={p1} hint={p1 ? (problem ?? 'Looks good') : 'At least 12 characters — several unrelated words is ideal'} /></div>
          <PassInput id="mp2" label="Confirm passphrase" value={p2} onChange={setP2} />
          <label className="mb-5 flex items-start gap-2.5 text-sm">
            <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I understand that if I forget this passphrase, my passwords are lost for good.</span>
          </label>
          {err && <p role="alert" className="mb-3 text-sm text-danger">{err}</p>}
          <button disabled={busy || !ack || !p1 || !p2} className="bg-accent w-full rounded-lg py-3 text-sm font-semibold text-on-accent">{busy ? 'Creating…' : 'Create vault'}</button>
        </form>
      </Card>
    </Shell>
  )
}

/** The vault exists but is locked (new tab, idle timeout, sign-in). */
export function UnlockScreen() {
  const { unlock, resetVault } = useVault()
  const [p, setP] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [forgot, setForgot] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      if (!(await unlock(p))) { setErr('That passphrase is wrong.'); setP('') }
    } catch (er) { setErr((er as Error).message || 'Couldn’t unlock.') } finally { setBusy(false) }
  }

  return (
    <Shell>
      <div className="rise mb-6 text-center">
        <span className="bg-accent mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl text-on-accent"><IconLock size={26} /></span>
        <h1 className="text-[28px] font-bold leading-tight">Passwords<span className="text-accent">.</span></h1>
        <p className="mt-2 text-sm text-muted">Locked. Enter your master passphrase.</p>
      </div>
      <Card>
        <form onSubmit={submit} autoComplete="off">
          <PassInput id="unlock" label="Master passphrase" value={p} onChange={setP} autoFocus />
          {err && <p role="alert" className="-mt-2 mb-3 text-sm text-danger">{err}</p>}
          <button disabled={busy || !p} className="bg-accent w-full rounded-lg py-3 text-sm font-semibold text-on-accent">{busy ? 'Unlocking…' : 'Unlock'}</button>
          <p className="mt-4 text-center text-xs text-faint">Forgot it? <button type="button" className="text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setForgot(true)}>Erase the vault and start over</button></p>
        </form>
      </Card>

      <Dialog open={forgot} onClose={() => { setForgot(false); setConfirmText('') }} title="Erase the vault">
        <h2 className="mb-2 text-base font-semibold text-danger">Erase every saved password?</h2>
        <p className="mb-4 text-sm text-muted">Without the passphrase the saved passwords can’t be decrypted by anyone — not even me or Supabase. Erasing deletes them permanently so you can create a fresh vault. This cannot be undone.</p>
        <label className="label-caps mb-1.5 block" htmlFor="rst">Type ERASE to confirm</label>
        <input id="rst" className="field mb-4" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        <div className="flex justify-end gap-2">
          <button className="rounded-lg px-4 py-2 text-sm hover:bg-hover" onClick={() => { setForgot(false); setConfirmText('') }}>Cancel</button>
          <button disabled={confirmText !== 'ERASE'} className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white" onClick={() => void resetVault().then(() => setForgot(false))}>Erase permanently</button>
        </div>
      </Dialog>
    </Shell>
  )
}
