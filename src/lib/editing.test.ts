import { describe, expect, it } from 'vitest'
import { applyPick, continueList, detectTrigger, indentLines, insertAt, prefixLine, safeLabel } from './editing'

describe('continueList', () => {
  it('continues bullets, numbers and task boxes', () => {
    expect(continueList('- a', 3)).toEqual({ value: '- a\n- ', start: 6, end: 6 })
    expect(continueList('1. a', 4)?.value).toBe('1. a\n2. ')
    expect(continueList('- [x] done', 10)?.value).toBe('- [x] done\n- [ ] ')
    expect(continueList('  * nested', 10)?.value).toBe('  * nested\n  * ')
  })
  it('an empty item ends the list', () => {
    expect(continueList('- a\n- ', 6)).toEqual({ value: '- a\n', start: 4, end: 4 })
    expect(continueList('- [ ] ', 6)?.value).toBe('')
  })
  it('does nothing outside lists or mid-line', () => {
    expect(continueList('plain', 5)).toBeNull()
    expect(continueList('- abc', 3)).toBeNull()
  })
})

describe('indentLines', () => {
  it('indents and outdents list lines, leaves others alone', () => {
    expect(indentLines('- a\n- b', 0, 7, false)?.value).toBe('  - a\n  - b')
    expect(indentLines('  - a', 5, 5, true)?.value).toBe('- a')
    expect(indentLines('plain text', 2, 2, false)).toBeNull()
  })
})

describe('prefixLine', () => {
  it('adds, toggles and swaps markers', () => {
    expect(prefixLine('hello', 3, '? ').value).toBe('? hello')
    expect(prefixLine('? hello', 4, '? ').value).toBe('hello')
    expect(prefixLine('? hello', 4, '! ').value).toBe('! hello')
    expect(prefixLine('a\nhello\nb', 4, '- [ ] ').value).toBe('a\n- [ ] hello\nb')
    expect(prefixLine('- [x] done', 5, '! ').value).toBe('! done')
  })
})

describe('triggers', () => {
  it('detects an open [[ link query', () => {
    const t = detectTrigger('see [[JVM Mem', 13)
    expect(t).toEqual({ type: 'link', query: 'JVM Mem', start: 4, end: 13 })
    expect(detectTrigger('see [[done]] more', 17)).toBeNull()
  })
  it('detects #tag but not headings or mid-word #', () => {
    expect(detectTrigger('note #jv', 8)).toEqual({ type: 'tag', query: 'jv', start: 5, end: 8 })
    expect(detectTrigger('# Heading', 9)).toBeNull()
    expect(detectTrigger('a#b', 3)).toBeNull()
    expect(detectTrigger('(#jvm/me', 8)?.query).toBe('jvm/me')
  })
  it('applyPick replaces the trigger text and swallows a typed ]]', () => {
    const t = detectTrigger('see [[JV]]', 8)!
    expect(applyPick('see [[JV]]', t, '[[N-260920-042|JVM]]').value).toBe('see [[N-260920-042|JVM]]')
    const g = detectTrigger('x #ja', 5)!
    expect(applyPick('x #ja', g, '#java ')).toEqual({ value: 'x #java ', start: 8, end: 8 })
  })
  it('insertAt / safeLabel', () => {
    expect(insertAt('ab', 1, 1, 'X')).toEqual({ value: 'aXb', start: 2, end: 2 })
    expect(safeLabel('a|b]]\nc')).toBe('a b c')
  })
})
