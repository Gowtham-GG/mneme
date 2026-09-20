import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from './markdown'
import { deriveTitle, displayTitle, previewText, removeInlineTag, splitHighlight, toggleTaskInContent } from './text'

describe('parseInline', () => {
  it('finds tags but not URL anchors, code or entities', () => {
    const c = parseInline('#Java and #jvm/memory, (#spring) http://x.com/a#frag `#code` &#39; # Heading')
    const tags = c.filter((x) => x.t === 'tag').map((x) => (x as { name: string }).name)
    expect(tags).toEqual(['java', 'jvm/memory', 'spring'])
  })
  it('parses [[links]] by title and by ID with labels', () => {
    const c = parseInline('see [[JVM Memory]] and [[n-260920-042|Class loading]] and N-260920-043')
    expect(c.filter((x) => x.t === 'noteLink')).toEqual([
      { t: 'noteLink', ref: 'JVM Memory', label: 'JVM Memory', isId: false },
      { t: 'noteLink', ref: 'N-260920-042', label: 'Class loading', isId: true },
    ])
    expect(c.filter((x) => x.t === 'id')).toEqual([{ t: 'id', id: 'N-260920-043' }])
  })
  it('handles bold, italic and urls without trailing punctuation', () => {
    const c = parseInline('**bold** and *it* see https://a.dev/x.')
    expect(c[0]).toEqual({ t: 'bold', c: [{ t: 'text', v: 'bold' }] })
    expect(c.some((x) => x.t === 'italic')).toBe(true)
    expect(c.find((x) => x.t === 'url')).toEqual({ t: 'url', href: 'https://a.dev/x', v: 'https://a.dev/x' })
  })
  it('never produces HTML: raw markup stays text', () => {
    const c = parseInline('<script>alert(1)</script>')
    expect(c).toEqual([{ t: 'text', v: '<script>alert(1)</script>' }])
  })
})

describe('parseBlocks', () => {
  const src = ['# Title', '- [ ] Read docs', '  - [x] nested done', '1. [ ] numbered', '- plain bullet', '> continues', '? why', '! important', '★ key', '× dropped', '```', '- [ ] in fence', '```', '---', '', 'free line'].join('\n')
  const b = parseBlocks(src)
  it('classifies lines', () => {
    expect(b.map((x) => x.t)).toEqual(['heading', 'item', 'item', 'item', 'item', 'quote', 'symbol', 'symbol', 'symbol', 'symbol', 'code', 'hr', 'blank', 'line'])
  })
  it('tasks carry state and the original 1-based line number', () => {
    const tasks = b.filter((x) => x.t === 'item' && x.task) as Extract<(typeof b)[number], { t: 'item' }>[]
    expect(tasks.map((t) => [t.line, t.task!.done])).toEqual([[2, false], [3, true], [4, false]])
    expect(tasks[1].indent).toBe(1)
  })
  it('does not treat a checkbox inside a code fence as a task', () => {
    const code = b.find((x) => x.t === 'code') as { v: string }
    expect(code.v).toBe('- [ ] in fence')
  })
  it('an empty "- [ ]" is a plain bullet, matching the SQL parser', () => {
    const [x] = parseBlocks('- [ ]')
    expect(x.t === 'item' && x.task).toBe(null)
  })
})

describe('text helpers', () => {
  it('deriveTitle uses the first meaningful line, skipping fences and markers', () => {
    expect(deriveTitle('```\ncode\n```\n\n## Hello **world**\nnext')).toBe('Hello world')
    expect(deriveTitle('- [ ] Read the docs')).toBe('Read the docs')
    expect(deriveTitle('see [[N-260920-042|Class loading]]')).toBe('see Class loading')
    expect(deriveTitle('')).toBe('')
  })
  it('previewText hides the line already used as the derived title', () => {
    expect(previewText({ title: null, snippet: 'first\nsecond\nthird' })).toBe('second · third')
    expect(previewText({ title: 'T', snippet: 'first\nsecond' })).toBe('first · second')
  })
  it('displayTitle prefers the plain preview and never leaks highlight markers', () => {
    expect(displayTitle({ title: null, snippet: '…resolves «beans» by type', preview: 'Spring notes\nresolves beans by type' })).toBe('Spring notes')
    expect(displayTitle({ title: null, snippet: 'a «b» c' })).toBe('a b c')
    expect(displayTitle({ title: '  Set  ', snippet: 'x' })).toBe('Set')
  })
  it('splitHighlight separates «hits»', () => {
    expect(splitHighlight('a «b» c')).toEqual([{ text: 'a ', hit: false }, { text: 'b', hit: true }, { text: ' c', hit: false }])
  })
  it('toggleTaskInContent flips only the targeted line', () => {
    const s = '- [ ] a\n- [ ] b\n- [x] c'
    expect(toggleTaskInContent(s, 2, true)).toBe('- [ ] a\n- [x] b\n- [x] c')
    expect(toggleTaskInContent(s, 3, false)).toBe('- [ ] a\n- [ ] b\n- [ ] c')
    expect(toggleTaskInContent(s, 99, true)).toBe(s)
  })
  it('removeInlineTag removes only the exact tag', () => {
    expect(removeInlineTag('a #java b #javascript c', 'java')).toBe('a b #javascript c')
    expect(removeInlineTag('#jvm/memory and #jvm', 'jvm')).toBe('#jvm/memory and')
  })
})
