// Pure helpers for the Passwords screen: website normalisation, grouping, search, CSV import/export.
import type { VaultSecret } from './vaultCrypto'

export interface VaultItem extends VaultSecret { id: string; createdAt: string; updatedAt: string }

const DOMAINISH = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

/** "https://www.GitHub.com/login" → "github.com". Anything that is not a domain/URL is just lower-cased text. */
export function siteKey(site: string): string {
  const raw = site.trim()
  if (!raw) return ''
  const noProto = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const host = noProto.split(/[/?#]/)[0].replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^www\./i, '')
  if (DOMAINISH.test(host) || /^localhost$/i.test(host)) return host.toLowerCase()
  return raw.toLowerCase().replace(/\s+/g, ' ')
}

/** A safe http(s) link for the site, or null (never javascript:, data:, etc.). */
export function siteHref(site: string): string | null {
  const raw = site.trim()
  if (!raw) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  if (/\s/.test(candidate)) return null
  try {
    const u = new URL(candidate)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const host = u.hostname.replace(/^www\./i, '')
    return DOMAINISH.test(host) || host === 'localhost' ? u.toString() : null
  } catch { return null }
}

export interface SiteGroup { key: string; label: string; href: string | null; items: VaultItem[] }

/** One group per website; several logins per site are listed together. Sorted A→Z. */
export function groupBySite(items: VaultItem[], query = ''): SiteGroup[] {
  const q = query.trim().toLowerCase()
  const visible = q
    ? items.filter((i) => [i.site, i.username, i.notes].some((f) => f.toLowerCase().includes(q)))
    : items
  const map = new Map<string, SiteGroup>()
  for (const it of visible) {
    const key = siteKey(it.site) || '(no website)'
    let g = map.get(key)
    if (!g) { g = { key, label: key === '(no website)' ? 'No website' : (/^[a-z][a-z0-9+.-]*:\/\//i.test(it.site.trim()) || DOMAINISH.test(key) ? key : it.site.trim()), href: siteHref(it.site), items: [] }; map.set(key, g) }
    g.items.push(it)
  }
  const groups = [...map.values()]
  for (const g of groups) g.items.sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }) || a.createdAt.localeCompare(b.createdAt))
  return groups.sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }))
}

// -------------------------------------------------------------------- CSV ----
/** RFC-4180 parser: quoted fields, escaped quotes (""), commas and newlines inside quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQ = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++ } else inQ = false } else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.length > 1 || row[0] !== '') rows.push(row)
  return rows
}

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

const HEADERS = {
  site: ['url', 'login_uri', 'website', 'web site', 'site', 'origin', 'hostname', 'address'],
  name: ['name', 'title', 'account', 'login_name'],
  username: ['username', 'login_username', 'user', 'user name', 'login', 'email', 'e-mail', 'account name'],
  password: ['password', 'login_password', 'pass', 'passphrase'],
  notes: ['note', 'notes', 'extra', 'comment', 'comments', 'notesplain'],
  type: ['type'],
}

export interface ImportResult { items: VaultSecret[]; skipped: number; format: string }

/** Understands Chrome / Edge, Bitwarden, 1Password, LastPass and generic CSV exports (matched by column names). */
export function itemsFromCsv(text: string): ImportResult {
  const rows = parseCsv(text)
  if (rows.length < 2) return { items: [], skipped: 0, format: 'empty' }
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const col = (names: string[]) => head.findIndex((h) => names.includes(h))
  const ci = { site: col(HEADERS.site), name: col(HEADERS.name), user: col(HEADERS.username), pass: col(HEADERS.password), notes: col(HEADERS.notes), type: col(HEADERS.type) }
  if (ci.pass < 0 || (ci.site < 0 && ci.name < 0)) return { items: [], skipped: rows.length - 1, format: 'unrecognised' }

  const format = head.includes('login_uri') ? 'Bitwarden' : head.includes('grouping') ? 'LastPass' : head.includes('title') ? '1Password' : head.includes('note') && head.includes('name') ? 'Chrome' : 'CSV'
  const items: VaultSecret[] = []
  let skipped = 0
  for (const r of rows.slice(1)) {
    const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
    if (ci.type >= 0 && get(ci.type) && get(ci.type).toLowerCase() !== 'login') { skipped++; continue } // Bitwarden notes/cards/identities
    const password = ci.pass >= 0 ? (r[ci.pass] ?? '') : ''
    const site = get(ci.site) || get(ci.name)
    const username = get(ci.user)
    if (!password && !username) { skipped++; continue }
    if (!site) { skipped++; continue }
    const nameNote = ci.site >= 0 && ci.name >= 0 && get(ci.name) && siteKey(get(ci.name)) !== siteKey(site) ? `Name: ${get(ci.name)}` : '' // Chrome's name just repeats the host
    const notes = [nameNote, get(ci.notes)].filter(Boolean).join('\n')
    items.push({ site, username, password, notes })
  }
  return { items, skipped, format }
}

/** Chrome-compatible export so the data can move to any other manager. Contains PLAINTEXT — the UI warns first. */
export function itemsToCsv(items: VaultItem[]): string {
  return toCsv([['name', 'url', 'username', 'password', 'note'], ...items.map((i) => [siteKey(i.site) || i.site, siteHref(i.site) ?? '', i.username, i.password, i.notes])])
}

/** Same website + username + password → treated as already present when importing. */
export const dedupeKey = (s: Pick<VaultSecret, 'site' | 'username' | 'password'>) => `${siteKey(s.site)}\u0000${s.username.toLowerCase()}\u0000${s.password}`
