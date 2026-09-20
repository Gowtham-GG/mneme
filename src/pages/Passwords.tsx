import { useEffect, useMemo, useRef, useState } from 'react'
import { download } from '@/api/export'
import { Card } from '@/components/Card'
import { ConfirmDialog, Dialog } from '@/components/Dialog'
import { IconEdit, IconExternal, IconLock, IconMore, IconPlus, IconSearch } from '@/components/icons'
import { CopyButton } from '@/components/vault/CopyButton'
import { CredentialDialog, draftFromItem, type CredentialDraft } from '@/components/vault/CredentialDialog'
import { SecretText } from '@/components/vault/SecretText'
import { StrengthMeter } from '@/components/vault/StrengthMeter'
import { SetupScreen, UnlockScreen } from '@/components/vault/VaultGate'
import { useToast } from '@/contexts/ToastContext'
import { TIMEOUT_CHOICES, useVault } from '@/contexts/VaultContext'
import { masterPassphraseProblem } from '@/lib/vaultCrypto'
import { groupBySite, itemsFromCsv, itemsToCsv, type ImportResult, type SiteGroup } from '@/lib/vaultData'

function SiteAvatar({ label }: { label: string }) {
  return <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-base font-semibold uppercase text-accent" aria-hidden>{label.trim()[0] ?? '?'}</span>
}

function GroupCard({ g, onAdd, onEdit }: { g: SiteGroup; onAdd: (site: string) => void; onEdit: (id: string) => void }) {
  return (
    <Card pad={false} className="rise" title={undefined}>
      <div className="flex items-center gap-3 px-5 pb-3 pt-4">
        <SiteAvatar label={g.label} />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 truncate text-[17px] font-semibold leading-tight">
            <span className="truncate">{g.label}</span>
            {g.href && <a href={g.href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${g.label}`} title={`Open ${g.label}`} className="shrink-0 text-faint hover:text-accent"><IconExternal size={16} /></a>}
          </h2>
          <p className="text-xs text-muted">{g.items.length} login{g.items.length === 1 ? '' : 's'}</p>
        </div>
        <button className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted hover:bg-hover hover:text-ink" onClick={() => onAdd(g.items[0].site)} aria-label={`Add another login for ${g.label}`}>
          <IconPlus size={14} /> Add login
        </button>
      </div>
      <div className="hidden gap-4 border-t border-line px-5 pb-1 pt-3 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem]">
        <span className="label-caps">Username / email</span><span className="label-caps">Password</span><span />
      </div>
      {g.items.map((it) => (
        <div key={it.id} className="grid gap-x-4 gap-y-2 border-t border-line px-5 py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem] md:items-center md:border-t-0">
          <div className="min-w-0">
            <span className="label-caps mb-1 block md:hidden">Username / email</span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate rounded-lg bg-panel px-3 py-2 text-sm" title={it.username}>{it.username || <span className="text-faint">—</span>}</span>
              <CopyButton value={it.username} label="username" />
            </div>
          </div>
          <div className="min-w-0">
            <span className="label-caps mb-1 block md:hidden">Password</span>
            <SecretText value={it.password} />
          </div>
          <button className="inline-flex size-9 items-center justify-center justify-self-end rounded-lg text-muted hover:bg-hover hover:text-ink" onClick={() => onEdit(it.id)} aria-label={`Edit login ${it.username || g.label}`} title="Edit">
            <IconEdit size={17} />
          </button>
          {it.notes && <p className="col-span-full -mt-1 line-clamp-2 whitespace-pre-line text-xs text-muted md:col-span-3">{it.notes}</p>}
        </div>
      ))}
    </Card>
  )
}

function Unlocked() {
  const v = useVault()
  const { toast } = useToast()
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<CredentialDraft | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [exportAsk, setExportAsk] = useState(false)
  const [importing, setImporting] = useState<ImportResult | null>(null)
  const [pass, setPass] = useState(false)
  const [resetAsk, setResetAsk] = useState(false)
  const file = useRef<HTMLInputElement>(null)

  const groups = useMemo(() => groupBySite(v.items, q), [v.items, q])
  const sites = useMemo(() => v.items.map((i) => i.site), [v.items])
  const openNew = (site = '') => { setEditing({ site, username: '', password: '', notes: '' }); setDialogOpen(true) }
  const openEdit = (id: string) => { const it = v.items.find((x) => x.id === id); if (it) { setEditing(draftFromItem(it)); setDialogOpen(true) } }

  const onFile = async (f: File | undefined) => {
    if (!f) return
    try { setImporting(itemsFromCsv(await f.text())) } catch { toast('Couldn’t read that file.', { kind: 'error' }) }
    if (file.current) file.current.value = ''
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="page-top mx-auto max-w-4xl px-4 pb-32 lg:px-6 lg:pb-8">
        <header className="rise relative z-20 mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="label-caps">Encrypted vault · {v.items.length} login{v.items.length === 1 ? '' : 's'}</p>
            <h1 className="mt-1 text-[34px] font-bold leading-tight">Passwords<span className="text-accent">.</span></h1>
          </div>
          <div className="flex items-center gap-2">
            <button className="bg-accent inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-sm font-semibold text-on-accent" onClick={() => openNew()}><IconPlus size={17} /> Add login</button>
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2.5 text-sm font-medium hover:bg-hover" onClick={v.lock} aria-label="Lock the vault now"><IconLock size={16} /> Lock</button>
            <div className="relative">
              <button className="inline-flex size-10 items-center justify-center rounded-lg border border-line text-muted hover:bg-hover hover:text-ink" aria-haspopup="menu" aria-expanded={menu} aria-label="Vault options" onClick={() => setMenu((x) => !x)}><IconMore size={18} /></button>
              {menu && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
                  <div role="menu" className="glass-strong pop absolute right-0 z-30 mt-2 w-64 rounded-2xl p-1.5">
                    <button role="menuitem" className="block w-full rounded-xl px-3 py-2.5 text-left text-sm hover:bg-hover" onClick={() => { setMenu(false); file.current?.click() }}>Import from CSV…</button>
                    <button role="menuitem" className="block w-full rounded-xl px-3 py-2.5 text-left text-sm hover:bg-hover" onClick={() => { setMenu(false); setExportAsk(true) }}>Export as CSV…</button>
                    <button role="menuitem" className="block w-full rounded-xl px-3 py-2.5 text-left text-sm hover:bg-hover" onClick={() => { setMenu(false); setPass(true) }}>Change master passphrase…</button>
                    <label className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm">
                      Auto-lock after
                      <select value={v.timeoutMin} onChange={(e) => v.setTimeoutMin(Number(e.target.value))} className="rounded-lg border border-line bg-transparent px-2 py-1 text-sm" aria-label="Auto-lock after">
                        {TIMEOUT_CHOICES.map((m) => <option key={m} value={m}>{m} min</option>)}
                      </select>
                    </label>
                    <div className="mx-2 my-1 h-px bg-line" />
                    <button role="menuitem" className="block w-full rounded-xl px-3 py-2.5 text-left text-sm text-danger hover:bg-danger-soft" onClick={() => { setMenu(false); setResetAsk(true) }}>Erase the vault…</button>
                  </div>
                </>
              )}
            </div>
            <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} aria-label="Choose a CSV file to import" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
        </header>

        <div className="relative mb-5">
          <IconSearch className="pointer-events-none absolute left-4 top-1/2 z-10 -translate-y-1/2 text-faint" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search passwords" placeholder="Search websites, usernames, notes…" className="glass w-full rounded-2xl py-3 pl-11 pr-4 text-[15px] outline-none"
            autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
        </div>

        {v.undecryptable > 0 && (
          <p role="alert" className="mb-4 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">{v.undecryptable} record{v.undecryptable === 1 ? '' : 's'} couldn’t be decrypted and are hidden (they were not deleted). This can happen if data was modified outside Mneme.</p>
        )}

        {v.items.length === 0 ? (
          <Card className="rise text-center">
            <p className="text-lg font-semibold">Your vault is empty</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Add a login, or import a CSV exported from your browser or another password manager.</p>
            <div className="mt-5 flex justify-center gap-2">
              <button className="bg-accent rounded-lg px-5 py-2.5 text-sm font-semibold text-on-accent" onClick={() => openNew()}>Add your first login</button>
              <button className="rounded-lg border border-line px-4 py-2.5 text-sm hover:bg-hover" onClick={() => file.current?.click()}>Import CSV</button>
            </div>
          </Card>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-faint">No logins match “{q}”.</p>
        ) : (
          <div className="space-y-4">{groups.map((g) => <GroupCard key={g.key} g={g} onAdd={openNew} onEdit={openEdit} />)}</div>
        )}
      </div>

      <CredentialDialog open={dialogOpen} onClose={() => setDialogOpen(false)} initial={editing} sites={sites}
        onSave={async (d) => { await v.saveItem(d); toast(d.id ? 'Login updated' : 'Login saved (encrypted)') }}
        onDelete={(id) => { setDialogOpen(false); setConfirmDelete(id) }} />

      <ConfirmDialog open={!!confirmDelete} title="Delete this login?" danger confirmLabel="Delete" onClose={() => setConfirmDelete(null)}
        body="It is permanently removed from your vault. This can’t be undone."
        onConfirm={() => { const id = confirmDelete!; void v.removeItem(id).then(() => toast('Login deleted')).catch(() => toast('Couldn’t delete it.', { kind: 'error' })) }} />

      <ConfirmDialog open={exportAsk} title="Export unencrypted CSV?" danger confirmLabel="Export" onClose={() => setExportAsk(false)}
        body="The file will contain every password in PLAIN TEXT. Anyone who gets the file can read them. Keep it somewhere safe and delete it when you’re done."
        onConfirm={() => { download(`mneme-passwords-${new Date().toISOString().slice(0, 10)}.csv`, itemsToCsv(v.items), 'text/csv'); toast(`Exported ${v.items.length} logins`) }} />

      <ImportDialog result={importing} onClose={() => setImporting(null)} />
      <ChangePassphraseDialog open={pass} onClose={() => setPass(false)} />
      <EraseDialog open={resetAsk} onClose={() => setResetAsk(false)} />
    </div>
  )
}

function ImportDialog({ result, onClose }: { result: ImportResult | null; onClose: () => void }) {
  const v = useVault()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (!result) return
    setBusy(true)
    try {
      const r = await v.importItems(result.items)
      toast(`Imported ${r.added} login${r.added === 1 ? '' : 's'}${r.duplicates ? ` · ${r.duplicates} already in the vault` : ''}`)
      onClose()
    } catch (e) { toast((e as Error).message || 'Import failed.', { kind: 'error' }) } finally { setBusy(false) }
  }
  return (
    <Dialog open={!!result} onClose={onClose} title="Import passwords">
      <h2 className="mb-2 text-lg font-semibold">Import passwords</h2>
      {result && (result.items.length === 0
        ? <p className="mb-5 text-sm text-muted">I couldn’t find any logins in that file{result.format === 'unrecognised' ? ' (the columns weren’t recognised — it needs at least a website and a password column)' : ''}.</p>
        : <p className="mb-5 text-sm text-muted">Found <b className="text-ink">{result.items.length}</b> login{result.items.length === 1 ? '' : 's'} ({result.format} format){result.skipped ? `, ${result.skipped} skipped` : ''}. They’ll be encrypted in your browser before being saved. Exact duplicates are skipped.</p>)}
      <div className="flex justify-end gap-2">
        <button className="rounded-lg px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button disabled={busy || !result?.items.length} className="bg-accent rounded-lg px-5 py-2 text-sm font-semibold text-on-accent" onClick={() => void run()}>{busy ? 'Encrypting…' : 'Import'}</button>
      </div>
      <p className="mt-4 text-xs text-faint">Tip: delete the CSV afterwards — it contains your passwords in plain text.</p>
    </Dialog>
  )
}

function ChangePassphraseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const v = useVault()
  const { toast } = useToast()
  const [cur, setCur] = useState(''), [n1, setN1] = useState(''), [n2, setN2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (open) { setCur(''); setN1(''); setN2(''); setErr(null) } }, [open])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const problem = masterPassphraseProblem(n1)
    if (problem) { setErr(problem); return }
    if (n1 !== n2) { setErr('The new passphrases don’t match.'); return }
    setBusy(true); setErr(null)
    try { await v.changePassphrase(cur, n1); toast('Master passphrase changed'); onClose() } catch (er) { setErr((er as Error).message) } finally { setBusy(false) }
  }
  const field = (id: string, label: string, val: string, set: (s: string) => void) => (
    <>
      <label className="label-caps mb-1.5 block" htmlFor={id}>{label}</label>
      <input id={id} type="password" className="field mb-4" value={val} onChange={(e) => set(e.target.value)} autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
    </>
  )
  return (
    <Dialog open={open} onClose={onClose} title="Change master passphrase">
      <form onSubmit={submit} autoComplete="off">
        <h2 className="mb-2 text-lg font-semibold">Change master passphrase</h2>
        <p className="mb-5 text-sm text-muted">Every saved login is re-encrypted with the new passphrase in one all-or-nothing step.</p>
        {field('cp0', 'Current passphrase', cur, setCur)}
        {field('cp1', 'New passphrase', n1, setN1)}
        <div className="-mt-2 mb-4"><StrengthMeter password={n1} /></div>
        {field('cp2', 'Confirm new passphrase', n2, setN2)}
        {err && <p role="alert" className="mb-3 text-sm text-danger">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-lg px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
          <button disabled={busy || !cur || !n1 || !n2} className="bg-accent rounded-lg px-5 py-2 text-sm font-semibold text-on-accent">{busy ? 'Re-encrypting…' : 'Change passphrase'}</button>
        </div>
      </form>
    </Dialog>
  )
}

function EraseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const v = useVault()
  const { toast } = useToast()
  const [t, setT] = useState('')
  useEffect(() => { if (open) setT('') }, [open])
  return (
    <Dialog open={open} onClose={onClose} title="Erase the vault">
      <h2 className="mb-2 text-base font-semibold text-danger">Erase the whole vault?</h2>
      <p className="mb-4 text-sm text-muted">All saved logins are permanently deleted. Use “Export as CSV” first if you want a copy. This cannot be undone.</p>
      <label className="label-caps mb-1.5 block" htmlFor="erase">Type ERASE to confirm</label>
      <input id="erase" className="field mb-4" value={t} onChange={(e) => setT(e.target.value)} autoComplete="off" />
      <div className="flex justify-end gap-2">
        <button className="rounded-lg px-4 py-2 text-sm hover:bg-hover" onClick={onClose}>Cancel</button>
        <button disabled={t !== 'ERASE'} className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white" onClick={() => void v.resetVault().then(() => { toast('Vault erased'); onClose() })}>Erase permanently</button>
      </div>
    </Dialog>
  )
}

export function Passwords() {
  const v = useVault()
  useEffect(() => { if (v.status === 'idle' || v.status === 'error') void v.load() }, [v.status]) // eslint-disable-line react-hooks/exhaustive-deps

  if (v.status === 'idle' || v.status === 'loading') return <div className="mx-auto max-w-md space-y-3 p-10" aria-busy="true"><div className="skeleton h-14" /><div className="skeleton h-40" /></div>
  if (v.status === 'error') return (
    <div className="mx-auto max-w-md p-10 text-center">
      <p className="mb-3 text-sm text-danger">{v.error ?? 'Couldn’t reach the vault.'}</p>
      <p className="mb-4 text-xs text-faint">If you haven’t yet, apply migration 20260921110000_mneme_08_vault.sql in Supabase.</p>
      <button className="rounded-lg border border-line px-4 py-2 text-sm hover:bg-hover" onClick={() => void v.load()}>Try again</button>
    </div>
  )
  if (v.status === 'none') return <SetupScreen />
  if (v.status === 'locked') return <UnlockScreen />
  return <Unlocked />
}
