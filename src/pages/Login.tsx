import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { resetPasswordForEmail, signIn, signUp } from '@/api/auth'
import { BigM } from '@/components/BigM'
import { useAuth } from '@/hooks/useAuth'
import { supabaseConfigError } from '@/lib/supabase'

function Eye({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.75" />
      {off && <path d="m4 4 16 16" />}
    </svg>
  )
}

export function Login() {
  const { session, loading } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  if (!loading && session) return <Navigate to="/" replace />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null); setInfo(null)
    try {
      if (mode === 'signin') await signIn(email.trim(), password)
      else { await signUp(email.trim(), password); setInfo('Account created. Check your inbox to confirm your email, then sign in.') }
    } catch (err) { setError((err as Error).message || 'Something went wrong.') } finally { setBusy(false) }
  }
  const reset = async () => {
    if (!email.trim()) { setError('Enter your email first.'); return }
    try { await resetPasswordForEmail(email.trim()); setInfo('Password reset email sent.'); setError(null) } catch (err) { setError((err as Error).message) }
  }

  return (
    <main className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-10">
      {/* the giant letter sits behind the card; the card is see-through so it shows through */}
      <BigM className="pointer-events-none absolute left-1/2 top-[44%] h-[min(50vh,400px)] -translate-x-[37.5%] -translate-y-1/2 select-none lg:top-1/2 lg:h-[min(74vh,660px)] lg:-translate-x-[54%]" />

      <div className="rise relative z-10 w-full max-w-[380px] lg:translate-x-6 lg:translate-y-2">
        {supabaseConfigError && <p role="alert" className="glass-strong mb-3 rounded-xl p-3.5 text-sm text-danger"><b className="block">Setup problem</b>{supabaseConfigError}</p>}
        <form onSubmit={submit} className="glass-clear rounded-3xl p-8">
          <h1 className="text-[28px] font-bold leading-none tracking-tight">Mneme<span className="text-accent">.</span></h1>
          <p className="mb-7 mt-2 text-sm text-ink/80">Your second memory. Capture now, find anything.</p>

          <label className="label-caps mb-1.5 block !text-muted" htmlFor="email">Email</label>
          <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="field mb-4" />

          <label className="label-caps mb-1.5 block !text-muted" htmlFor="password">Password</label>
          <div className="relative mb-5">
            <input id="password" type={show ? 'text' : 'password'} required minLength={6} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} className="field pr-11" />
            <button type="button" aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} onClick={() => setShow((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-faint hover:text-ink"><Eye off={show} /></button>
          </div>

          {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
          {info && <p role="status" className="mb-3 text-sm text-task">{info}</p>}

          <button disabled={busy} className="bg-accent w-full rounded-lg py-3 text-sm font-semibold text-on-accent">{busy ? 'Please wait…' : mode === 'signin' ? 'Meet Mneme.' : 'Create account'}</button>

          <p className="mt-5 text-center text-xs text-muted">
            {mode === 'signin' ? 'Don’t have an account? ' : 'Already have an account? '}
            <button type="button" className="text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null) }}>{mode === 'signin' ? 'Sign up' : 'Sign in'}</button>
            {mode === 'signin' && <> · <button type="button" className="text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => void reset()}>Forgot password?</button></>}
          </p>
        </form>
        <p className="mt-4 text-center text-xs text-muted">Already use Argus? Sign in with the same account.</p>
      </div>
    </main>
  )
}
