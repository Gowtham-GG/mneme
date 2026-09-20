// Pure text-editing helpers behind the plain <textarea> editor. Each takes the
// full text plus caret/selection and returns the new text + caret, so they are
// trivial to unit-test and have no DOM dependency.

export interface Edit { value: string; start: number; end: number }

const lineStartOf = (v: string, pos: number) => v.lastIndexOf('\n', pos - 1) + 1
const lineEndOf = (v: string, pos: number) => { const i = v.indexOf('\n', pos); return i === -1 ? v.length : i }

const LIST = /^(\s*)([-*+]|(\d+)([.)]))\s+(\[[ xX]\]\s+)?/

/** Enter inside a list: continue it ("- ", "3. ", "- [ ] "), or end it when the item is empty. null = default behaviour. */
export function continueList(v: string, caret: number): Edit | null {
  const ls = lineStartOf(v, caret)
  if (caret !== lineEndOf(v, caret)) return null // only when the caret is at the end of the line
  const line = v.slice(ls, caret)
  const m = LIST.exec(line)
  if (!m) return null
  if (line.slice(m[0].length).trim() === '') {
    const nv = v.slice(0, ls) + v.slice(caret) // empty item: leave the list
    return { value: nv, start: ls, end: ls }
  }
  const indent = m[1]
  const marker = m[3] !== undefined ? `${Number(m[3]) + 1}${m[4]}` : m[2]
  const box = m[5] ? '[ ] ' : ''
  const ins = `\n${indent}${marker} ${box}`
  return { value: v.slice(0, caret) + ins + v.slice(caret), start: caret + ins.length, end: caret + ins.length }
}

/** Tab / Shift+Tab on list-item lines in the selection. null when no selected line is a list item. */
export function indentLines(v: string, selStart: number, selEnd: number, outdent: boolean): Edit | null {
  const a = lineStartOf(v, selStart)
  const b = lineEndOf(v, Math.max(selStart, selEnd))
  const lines = v.slice(a, b).split('\n')
  if (!lines.some((l) => LIST.test(l))) return null
  let firstDelta = 0, total = 0
  const out = lines.map((l, i) => {
    if (!LIST.test(l)) return l
    if (outdent) {
      const cut = l.startsWith('  ') ? 2 : l.startsWith(' ') ? 1 : l.startsWith('\t') ? 1 : 0
      if (i === 0) firstDelta = -cut
      total -= cut
      return l.slice(cut)
    }
    if (i === 0) firstDelta = 2
    total += 2
    return '  ' + l
  })
  const nv = v.slice(0, a) + out.join('\n') + v.slice(b)
  return { value: nv, start: Math.max(a, selStart + firstDelta), end: Math.max(a, selEnd + total) }
}

/** Toggle a line marker ("- [ ] ", "? ", "! ", "★ ", "× ") at the start of the caret's line. */
export function prefixLine(v: string, caret: number, marker: string): Edit {
  const ls = lineStartOf(v, caret)
  const le = lineEndOf(v, caret)
  const line = v.slice(ls, le)
  if (line.startsWith(marker)) {
    return { value: v.slice(0, ls) + line.slice(marker.length) + v.slice(le), start: Math.max(ls, caret - marker.length), end: Math.max(ls, caret - marker.length) }
  }
  // replace a different simple marker instead of stacking them
  const stripped = line.replace(/^(?:- \[[ xX]\] |[?!★×→] )/, '')
  const removed = line.length - stripped.length
  const nv = v.slice(0, ls) + marker + stripped + v.slice(le)
  const pos = Math.max(ls + marker.length, caret + marker.length - removed)
  return { value: nv, start: pos, end: pos }
}

export function insertAt(v: string, start: number, end: number, text: string): Edit {
  return { value: v.slice(0, start) + text + v.slice(end), start: start + text.length, end: start + text.length }
}

export interface Trigger { type: 'link' | 'tag'; query: string; start: number; end: number }

/** Is the caret inside an unfinished "[[query" or "#query"? */
export function detectTrigger(v: string, caret: number): Trigger | null {
  const ls = lineStartOf(v, caret)
  const before = v.slice(ls, caret)
  const link = /\[\[([^\]\n]*)$/.exec(before)
  if (link) return { type: 'link', query: link[1].split('|')[0], start: ls + link.index, end: caret }
  const tag = /(?:^|[\s(])#([\p{L}\p{N}_/-]*)$/u.exec(before)
  if (tag) return { type: 'tag', query: tag[1], start: caret - tag[1].length - 1, end: caret }
  return null
}

export function applyPick(v: string, t: Trigger, insert: string): Edit {
  // swallow "]]" the user may already have typed right after the caret
  let end = t.end
  if (t.type === 'link' && v.slice(end, end + 2) === ']]') end += 2
  return insertAt(v, t.start, end, insert)
}

/** Label safe to put inside [[ID|label]]. */
export function safeLabel(s: string): string {
  return s.replace(/[\]|\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}
