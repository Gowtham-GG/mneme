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

const TASK_LINE = /^[ \t]*(?:[-*+]|\d+[.)])\s+\[([ xX/hH-])\]\s+\S/
const indentOf = (l: string) => (/^[ \t]*/.exec(l)?.[0] ?? '').replace(/\t/g, '    ').length
const markerOf = (l: string) => (TASK_LINE.exec(l)?.[1] ?? ' ').toLowerCase()
const setMarker = (l: string, m: string) => l.replace(/\[[ xX/hH-]\]/, `[${m}]`)

/** 0-based parent line of every checkbox line, by indentation — the same rule as mneme.sync_note_tasks. */
export function taskParents(lines: string[]): Map<number, number | null> {
  const out = new Map<number, number | null>()
  const stack: { ind: number; task: boolean; i: number }[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s{0,3}(```|~~~)/.test(l)) { fence = !fence; return }
    if (fence || !l.trim()) return
    const ind = indentOf(l)
    while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop()
    const task = TASK_LINE.test(l)
    if (task) out.set(i, [...stack].reverse().find((e) => e.task)?.i ?? null)
    stack.push({ ind, task, i })
  })
  return out
}

/**
 * Tick/untick the checkbox on 1-based `lineNo`, and mirror the parent roll-up in
 * the text (all subtasks finished -> [x]; progress -> [/]; reopened -> back),
 * like the database does — so the note reads the same as the Tasks page.
 */
export function toggleTaskInContent(content: string, lineNo: number, done: boolean): string {
  const lines = content.split('\n')
  const i = lineNo - 1
  if (i < 0 || i >= lines.length || !TASK_LINE.test(lines[i])) return content
  lines[i] = setMarker(lines[i], done ? 'x' : ' ')
  const parents = taskParents(lines)
  let p = parents.get(i) ?? null
  while (p !== null) {
    const kids = [...parents].filter(([, q]) => q === p).map(([k]) => markerOf(lines[k]))
    const ps = markerOf(lines[p])
    if (ps === 'h' || ps === '-') break // set by hand: left alone
    const res = kids.filter((m) => m === 'x' || m === '-').length
    const prog = kids.filter((m) => m === 'x' || m === '/').length
    const target = res === kids.length ? 'x' : ps === 'x' ? (prog ? '/' : ' ') : ps === ' ' && prog ? '/' : ps
    if (target === ps) break
    lines[p] = setMarker(lines[p], target)
    p = parents.get(p) ?? null
  }
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
