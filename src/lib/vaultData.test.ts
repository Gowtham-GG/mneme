import { describe, expect, it } from 'vitest'
import { dedupeKey, groupBySite, itemsFromCsv, itemsToCsv, parseCsv, siteHref, siteKey, toCsv, type VaultItem } from './vaultData'

const item = (site: string, username: string, extra: Partial<VaultItem> = {}): VaultItem => ({
  id: crypto.randomUUID(), site, username, password: 'pw-' + username, notes: '', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...extra,
})

describe('website normalisation', () => {
  it('reduces URLs to the bare domain', () => {
    expect(siteKey('https://www.GitHub.com/login?x=1#a')).toBe('github.com')
    expect(siteKey('github.com')).toBe('github.com')
    expect(siteKey('  WWW.Example.co.uk:8443/path ')).toBe('example.co.uk')
    expect(siteKey('http://user:pw@mail.example.com/')).toBe('mail.example.com')
  })
  it('keeps non-domain names as plain lower-case text', () => {
    expect(siteKey('My  Bank  App')).toBe('my bank app')
    expect(siteKey('')).toBe('')
  })
  it('only ever produces http(s) links', () => {
    expect(siteHref('github.com')).toBe('https://github.com/')
    expect(siteHref('http://intranet.local.example.com/x')).toBe('http://intranet.local.example.com/x')
    expect(siteHref('javascript:alert(1)')).toBeNull()
    expect(siteHref('data:text/html,<script>')).toBeNull()
    expect(siteHref('My Bank App')).toBeNull()
    expect(siteHref('ftp://files.example.com')).toBeNull()
  })
})

describe('grouping (one site, many logins)', () => {
  const items = [
    item('https://github.com/login', 'work@corp.com'), item('GitHub.com', 'me@home.com'), item('www.github.com', 'alt@home.com'),
    item('netflix.com', 'family'), item('My Bank App', 'acct-1'),
  ]
  it('groups the same website together however it was typed, sorted A→Z, logins sorted by username', () => {
    const g = groupBySite(items)
    expect(g.map((x) => x.key)).toEqual(['github.com', 'my bank app', 'netflix.com'])
    expect(g[0].items.map((i) => i.username)).toEqual(['alt@home.com', 'me@home.com', 'work@corp.com'])
    expect(g[0].href).toBe('https://github.com/login')
    expect(g[1].label).toBe('My Bank App')
  })
  it('search matches site, username and notes', () => {
    expect(groupBySite(items, 'home').flatMap((g) => g.items).length).toBe(2)
    expect(groupBySite(items, 'NETFLIX')).toHaveLength(1)
    expect(groupBySite([item('a.com', 'x', { notes: 'recovery code 42' })], 'recovery')).toHaveLength(1)
    expect(groupBySite(items, 'zzz')).toHaveLength(0)
  })
  it('an item with no website still appears', () => {
    expect(groupBySite([item('', 'orphan')])[0].label).toBe('No website')
  })
})

describe('CSV', () => {
  it('parses quotes, embedded commas/newlines, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi""\nbye"\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"\nbye']])
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([['a', 'b'], ['1', '2']])
  })
  it('round-trips awkward values exactly (passwords are never altered)', () => {
    const rows = [['n', 'p'], ['a,b', '=SUM(1)'], ['q"q', ' lead'], ['nl\nx', '+plus'], ['', '@at']]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
  it('imports Chrome exports', () => {
    const r = itemsFromCsv('name,url,username,password,note\ngithub.com,https://github.com/login,me,pw1,my note\n')
    expect(r.format).toBe('Chrome')
    expect(r.items).toEqual([{ site: 'https://github.com/login', username: 'me', password: 'pw1', notes: 'my note' }])
  })
  it('imports Bitwarden exports and skips non-login items', () => {
    const csv = 'folder,favorite,type,name,notes,login_uri,login_username,login_password\n,0,login,GH,n1,https://github.com,me,pw\n,0,note,Secret note,text,,,\n'
    const r = itemsFromCsv(csv)
    expect(r.format).toBe('Bitwarden')
    expect(r.items).toHaveLength(1); expect(r.skipped).toBe(1)
    expect(r.items[0]).toMatchObject({ site: 'https://github.com', username: 'me', password: 'pw' })
  })
  it('imports 1Password / LastPass / generic column names', () => {
    expect(itemsFromCsv('Title,Url,Username,Password,Notes\nX,x.com,u,p,n\n').items[0]).toMatchObject({ site: 'x.com', username: 'u', password: 'p' })
    expect(itemsFromCsv('url,username,password,extra,name,grouping,fav\ny.com,u,p,e,Y,,0\n').items[0]).toMatchObject({ site: 'y.com', notes: 'Name: Y\ne' })
    expect(itemsFromCsv('site,email,pass\nz.com,a@b.c,secret\n').items[0]).toMatchObject({ site: 'z.com', username: 'a@b.c', password: 'secret' })
  })
  it('falls back to the name column when there is no URL and reports what it could not read', () => {
    expect(itemsFromCsv('name,username,password\nMy Bank,u,p\n').items[0].site).toBe('My Bank')
    expect(itemsFromCsv('foo,bar\n1,2\n').format).toBe('unrecognised')
    expect(itemsFromCsv('name,url,username,password\n,,,\nok,ok.com,u,p\n')).toMatchObject({ skipped: 1, items: [{ site: 'ok.com' }] })
  })
  it('exports a Chrome-compatible CSV and de-duplicates on re-import', () => {
    const items = [item('https://www.github.com/login', 'me', { password: 'a,b"c', notes: 'n' })]
    const csv = itemsToCsv(items)
    expect(csv.split('\r\n')[0]).toBe('name,url,username,password,note')
    const back = itemsFromCsv(csv).items[0]
    expect(back).toMatchObject({ username: 'me', password: 'a,b"c', notes: 'n' })
    expect(dedupeKey(back)).toBe(dedupeKey(items[0]))
  })
})
