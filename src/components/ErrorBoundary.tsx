import { Component, type ReactNode } from 'react'

/** Last line of defence: a crash anywhere shows a readable card instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('[Mneme] render error', error) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="flex min-h-full items-center justify-center p-6">
        <div className="glass-strong w-full max-w-md rounded-3xl p-8">
          <h1 className="mb-2 text-2xl font-bold">Something went wrong<span className="text-accent">.</span></h1>
          <p className="mb-4 text-sm text-muted">Your notes are safe. Reloading usually fixes it.</p>
          <pre className="mb-5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-panel p-3 text-xs text-muted">{this.state.error.message}</pre>
          <button className="bg-accent rounded-lg px-5 py-2.5 text-sm font-semibold text-on-accent" onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    )
  }
}
