// A deliberately small, line-oriented renderer model for note text.
// Produces plain data (no HTML) that React turns into elements, so there is no
// innerHTML and no XSS surface. Task checkbox rules match the SQL parser in
// migration 03 (mneme.note_task_lines): `- [ ] text`, `* [x] text`, `1. [ ] text`.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'url'; href: string; v: string }
  | { t: 'noteLink'; ref: string; label: string; isId: boolean }
  | { t: 'tag'; name: string; raw: string }
  | { t: 'id'; id: string }

export type Symbol = '?' | '!' | '★' | '×' | '→' | '↗'

export type Block =
  | { t: 'blank' }
  | { t: 'hr' }
  | { t: 'heading'; level: 1 | 2 | 3; c: Inline[]; line: number }
  | { t: 'item'; ordered: boolean; marker: string; indent: number; task: { done: boolean } | null; c: Inline[]; line: number }
  | { t: 'quote'; c: Inline[]; line: number }
  | { t: 'symbol'; sym: Symbol; c: Inline[]; line: number }
  | { t: 'code'; lang: string; v: string; line: number }
  | { t: 'line'; c: Inline[]; line: number }

// One alternation, scanned left to right. Lookbehinds mirror the SQL tag/ID rules.
const INLINE_RE = new RegExp(
  [
    '(`[^`\\n]+`)', //                                         1 code
    '(\\[\\[([^\\]\\n|]+)(?:\\|([^\\]\\n]*))?\\]\\])', //       2 [[ref|label]]  (3 ref, 4 label)
    '(https?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?\'")\\]])', //         5 url
    '(\\*\\*([^*\\n]+)\\*\\*)', //                              6 bold (7 inner)
    '((?<![\\p{L}\\p{N}_*])\\*([^*\\n]+)\\*(?![\\p{L}\\p{N}_*]))', // 8 italic (9)
    '((?<![\\p{L}\\p{N}_])_([^_\\n]+)_(?![\\p{L}\\p{N}_]))', //  10 italic (11)
    '((?<![\\p{L}\\p{N}_&/#])#(\\p{L}[\\p{L}\\p{N}_/-]*))', //    12 tag (13)
    '((?<![\\p{L}\\p{N}-])[Nn]-\\d{6}-\\d{3,}(?![\\p{L}\\p{N}-]))', // 14 bare id
  ].join('|'),
  'gu',
)

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  // Fresh instance per call: a global regex keeps lastIndex state, and the
  // recursive calls below (bold/italic contents) would otherwise corrupt it.
  const re = new RegExp(INLINE_RE.source, INLINE_RE.flags)
  let m: RegExpExecArray | null
  const push = (v: string) => { if (v) out.push({ t: 'text', v }) }
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index))
    if (m[1]) out.push({ t: 'code', v: m[1].slice(1, -1) })
    else if (m[2]) {
      const ref = m[3].trim()
      const isId = /^N-\d{6}-\d{3,}$/i.test(ref)
      out.push({ t: 'noteLink', ref: isId ? ref.toUpperCase() : ref, label: (m[4] ?? '').trim() || ref, isId })
    } else if (m[5]) out.push({ t: 'url', href: m[5], v: m[5] })
    else if (m[6]) out.push({ t: 'bold', c: parseInline(m[7]) })
    else if (m[8]) out.push({ t: 'italic', c: parseInline(m[9]) })
    else if (m[10]) out.push({ t: 'italic', c: parseInline(m[11]) })
    else if (m[12]) {
      const name = m[13].toLowerCase().replace(/[/-]+$/, '')
      out.push({ t: 'tag', name, raw: m[12] })
    } else if (m[14]) out.push({ t: 'id', id: m[14].toUpperCase() })
    last = m.index + m[0].length
  }
  push(text.slice(last))
  return out
}

const FENCE = /^\s{0,3}(```|~~~)\s*([\w-]*)/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const HEADING = /^(#{1,3})\s+(.*)$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+(?=\S))?(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const SYMBOL = /^\s*([?!★×→↗])(?:\s+(.*)|$)/

export function parseBlocks(content: string): Block[] {
  const out: Block[] = []
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const raw = lines[i].replace(/\r$/, '')
    const line = i + 1
    const fence = FENCE.exec(raw)
    if (fence) {
      const marker = fence[1]
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !new RegExp(`^\\s{0,3}${marker}`).test(lines[j])) { body.push(lines[j]); j++ }
      out.push({ t: 'code', lang: fence[2], v: body.join('\n'), line })
      i = j + 1 // skip the closing fence (or run to EOF)
      continue
    }
    i++
    if (!raw.trim()) { out.push({ t: 'blank' }); continue }
    if (HR.test(raw)) { out.push({ t: 'hr' }); continue }
    let m = HEADING.exec(raw)
    if (m) { out.push({ t: 'heading', level: m[1].length as 1 | 2 | 3, c: parseInline(m[2]), line }); continue }
    m = ITEM.exec(raw)
    if (m) {
      const spaces = m[1].replace(/\t/g, '  ').length
      out.push({
        t: 'item', ordered: /\d/.test(m[2]), marker: m[2], indent: Math.min(Math.floor(spaces / 2), 4),
        task: m[3] === undefined ? null : { done: m[3].toLowerCase() === 'x' }, c: parseInline(m[4]), line,
      })
      continue
    }
    m = QUOTE.exec(raw)
    if (m) { out.push({ t: 'quote', c: parseInline(m[1]), line }); continue }
    m = SYMBOL.exec(raw)
    if (m) { out.push({ t: 'symbol', sym: m[1] as Symbol, c: parseInline(m[2] ?? ''), line }); continue }
    out.push({ t: 'line', c: parseInline(raw), line })
  }
  return out
}
