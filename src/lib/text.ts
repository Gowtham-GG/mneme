import type { NoteListItem } from '@/types/db'

const ID_RE = /^N-\d{6}-\d{3,}$/i

export function isNoteId(s: string): boolean {
  return ID_RE.test(s.trim())
}

/** Strip leading markdown markers so "## Foo", "- [ ] Foo", "> Foo" read as "Foo". */
export function stripMarkers(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*[?!★×→↗]\s+/, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, ref: string, label?: string) => label || ref)
    .replace(/[*_`]/g, '')
    .trim()
}

/** First meaningful line of the body (used when a note has no title). */
export function deriveTitle(content: string, max = 80): string {
  let inFence = false
  for (const raw of content.split('\n')) {
    if (/^\s{0,3}(```|~~~)/.test(raw)) { inFence = !inFence; continue }
    if (inFence) continue
    const line = stripMarkers(raw)
    if (line) return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
  }
  return ''
}

/** Title to show in lists: explicit title, else first line, else "Untitled". */
export function displayTitle(n: { title: string | null; snippet?: string; preview?: string; content?: string }): string {
  if (n.title && n.title.trim()) return n.title.trim()
  // a search snippet is a highlighted mid-text fragment: prefer the plain preview, and never leak «» markers
  return deriveTitle((n.preview ?? n.content ?? n.snippet ?? '').replace(/[«»]/g, '')) || 'Untitled'
}

/** Body preview lines that are NOT the line already used as the title. */
export function previewText(n: Pick<NoteListItem, 'title' | 'snippet'>, maxChars = 160): string {
  const lines = n.snippet.split('\n').map((l) => l.trim()).filter(Boolean)
  let rest = lines
  if (!n.title?.trim() && lines.length) rest = lines.slice(1) // first line already became the title
  const joined = rest.map(stripMarkers).filter(Boolean).join(' · ')
  return joined.length > maxChars ? joined.slice(0, maxChars - 1).trimEnd() + '…' : joined
}

/** Split a search snippet that marks matches with «…» into plain/highlight segments. */
export function splitHighlight(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = []
  const re = /«([^»]*)»/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(snippet))) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), hit: false })
    out.push({ text: m[1], hit: true })
    last = m.index + m[0].length
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), hit: false })
  return out
}

/** Rewrite the checkbox on 1-based `lineNo` (mirrors mneme.set_task_done). */
export function toggleTaskInContent(content: string, lineNo: number, done: boolean): string {
  const lines = content.split('\n')
  const i = lineNo - 1
  if (i < 0 || i >= lines.length) return content
  lines[i] = lines[i].replace(/\[[ xX]\]/, done ? '[x]' : '[ ]')
  return lines.join('\n')
}

/** Remove an inline #tag token from the text (used when removing an inline tag chip). */
export function removeInlineTag(content: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const re = new RegExp(`(?<![\\p{L}\\p{N}_&/#])#${esc}(?![\\p{L}\\p{N}_/-])`, 'giu')
  return content.replace(re, '').replace(/[ \t]+$/gm, '').replace(/[ \t]{2,}/g, ' ')
}

export function wordCount(s: string): number {
  const t = s.trim()
  return t ? t.split(/\s+/).length : 0
}
