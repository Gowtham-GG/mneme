// Copy a secret and (best effort) wipe it from the clipboard afterwards.
let timer: ReturnType<typeof setTimeout> | undefined

export const CLIPBOARD_CLEAR_MS = 30_000

async function write(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try { // older browsers / permission quirks
      const ta = document.createElement('textarea')
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
      document.body.appendChild(ta); ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch { return false }
  }
}

/** Copies `text`. When `clearAfterMs` > 0 the clipboard is overwritten with an empty string after that time. */
export async function copySecret(text: string, clearAfterMs = CLIPBOARD_CLEAR_MS): Promise<boolean> {
  const ok = await write(text)
  clearTimeout(timer)
  if (ok && clearAfterMs > 0) timer = setTimeout(() => { void write(' ') }, clearAfterMs)
  return ok
}
