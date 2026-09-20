import { useLayoutEffect, useRef } from 'react'

/** Note title: a one-row textarea that grows with its text (long titles wrap instead of clipping). Enter moves to the body. */
export function TitleField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      maxLength={300}
      aria-label="Title (optional)"
      placeholder="Untitled"
      className="title-input mb-2 block resize-none overflow-hidden"
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
          e.preventDefault()
          document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note text"]')?.focus()
        }
      }}
    />
  )
}
