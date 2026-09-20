import { chromium } from 'playwright-core'
import crypto from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Screenshots land here. Run against the local stack (tests/integration/stack.sh) and a build made with
//   VITE_SUPABASE_URL=http://127.0.0.1:54331 VITE_SUPABASE_ANON_KEY=x npx vite build --outDir /tmp/mneme-e2e-dist
//   npx vite preview --outDir /tmp/mneme-e2e-dist --port 4173
// Needs `playwright-core` + a Chromium (npx playwright-core install chromium); it is NOT a project dependency.
const T = process.env.MNEME_E2E_DIR ?? '/tmp/mneme-e2e'
mkdirSync(T + '/shots', { recursive: true })
const SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
const UID = 'aaaaaaaa-0000-0000-0000-0000000000e2'
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '54329', '-U', 'postgres', '-d', 'postgres', '-Atc', sql]).toString().trim()
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 86400
const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub: UID, role: 'authenticated', aud: 'authenticated', exp })
const jwt = `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`
const session = JSON.stringify({ access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: 'x', user: { id: UID, aud: 'authenticated', role: 'authenticated', email: 'e2e@test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } })

psql(`insert into auth.users(id,email) values ('${UID}','e2e@test') on conflict do nothing`)
psql(`insert into mneme.settings(user_id,timezone) values ('${UID}','Asia/Kolkata') on conflict do nothing`)
// seed a little history (as admin: user_id given explicitly)
const seed = [
  ['JVM Memory', 'Heap, stack and metaspace. #java #jvm/memory', 'knowledge', "now() - interval '3 days'"],
  ['ClassLoader delegation', 'Parent delegation model.\n? why does the JVM use parent delegation\n- [ ] Read ClassLoader docs\n#java #jvm/classloading', 'question', "now() - interval '1 day'"],
  [null, 'Idea: a keyboard shortcut cheat sheet for the app', 'capture', "now() - interval '5 hours'"],
]
for (const [t, c, ty, at] of seed) psql(`insert into mneme.notes(user_id,title,content,note_type,created_at) values ('${UID}', ${t ? `'${t}'` : 'null'}, '${c.replace(/'/g, "''")}', '${ty}', ${at})`)

const errors = []
const log = (...a) => console.log(...a)
const browser = await chromium.launch()
const CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://127.0.0.1:54331; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
async function newCtx(viewport, colorScheme = 'light') {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 })
  await ctx.addInitScript((s) => { try { localStorage.setItem('mneme-auth', s) } catch {} }, session)
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('requestfailed', (r) => { if (!r.url().includes('/sw.js')) errors.push(`[reqfailed] ${r.method()} ${r.url()} ${r.failure()?.errorText}`) })
  return { ctx, page }
}
const shot = (page, name) => page.screenshot({ path: `${T}/shots/${name}.png`, fullPage: false })

// ---------------------------------------------------------------- desktop
{
  const { ctx, page } = await newCtx({ width: 1360, height: 860 })
  await page.goto('http://127.0.0.1:4173/')
  await page.waitForSelector('textarea[aria-label="Note text"]')
  log('home loaded; textarea focused:', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
  await shot(page, '01-home-empty')

  // quick capture
  await page.keyboard.type('Need to understand how Spring resolves beans #spring\n- [ ] Read the Spring docs')
  await page.keyboard.press('Control+Enter')
  await page.getByText(/Saved N-\d{6}-\d+/).first().waitFor({ timeout: 8000 })
  log('capture saved toast:', await page.locator('[role=status]').filter({ hasText: 'Saved N-' }).first().innerText())
  log('db note:', psql(`select public_id||' | '||content from mneme.notes where content like 'Need to understand%'`).replace(/\n/g, ' ⏎ '))
  log('db tags:', psql(`select string_agg(g.name, ',') from mneme.note_tags nt join mneme.tags g on g.id = nt.tag_id join mneme.notes n on n.id=nt.note_id where n.content like 'Need to understand%'`))
  log('db tasks:', psql(`select string_agg(title||':'||status, ',') from mneme.tasks where title like 'Read the Spring%'`))
  await page.waitForTimeout(400)
  await shot(page, '02-home-after-capture')
  log('box reset after save:', JSON.stringify(await page.inputValue('textarea[aria-label="Note text"]')))

  // timeline + open a note
  await page.goto('http://127.0.0.1:4173/notes')
  await page.waitForSelector('text=ClassLoader delegation')
  await shot(page, '03-notes')
  await page.click('text=ClassLoader delegation')
  await page.waitForSelector('text=Referenced by')
  await page.waitForTimeout(500)
  await shot(page, '04-note-view')

  // edit + [[ link picker
  await page.keyboard.press('e')
  await page.waitForSelector('textarea[aria-label="Note text"]')
  const ta = page.locator('textarea[aria-label="Note text"]')
  await ta.click(); await page.keyboard.press('Control+End')
  await page.keyboard.type('\nSee also [[JVM Mem')
  await page.waitForSelector('[role=listbox] >> text=JVM Memory', { timeout: 8000 })
  await shot(page, '05-link-picker')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Note text"]')?.value.includes('[[N-'), null, { timeout: 5000 })
  log('after pick:', JSON.stringify((await ta.inputValue()).split('\n').slice(-1)[0]))
  for (let i = 0; i < 40 && psql(`select count(*) from mneme.note_links`) === '0'; i++) await page.waitForTimeout(250)
  log('links in db:', psql(`select s.title||' -> '||t.title from mneme.note_links l join mneme.notes s on s.id=l.source_note_id join mneme.notes t on t.id=l.target_note_id`))
  await page.keyboard.press('Escape')
  await page.waitForSelector('text=Referenced by')
  await shot(page, '06-note-after-link')

  // backlink shows on the target
  await page.goto('http://127.0.0.1:4173/notes')
  await page.goto('http://127.0.0.1:4173/n/N-260918-001')
  await page.waitForSelector('text=Referenced by')
  await page.waitForTimeout(700)
  log('backlinks text:', (await page.locator('aside[aria-label="Note context"]').innerText()).replace(/\n+/g, ' | ').slice(0, 200))

  // tasks page
  await page.goto('http://127.0.0.1:4173/tasks')
  await page.waitForSelector('text=Read ClassLoader docs')
  await shot(page, '07-tasks')
  await page.getByRole('checkbox', { name: /Complete: Read ClassLoader docs/ }).click()
  await page.waitForSelector('text=/Done: Read ClassLoader docs/')
  await page.waitForTimeout(400)
  log('note text after tick:', psql(`select content from mneme.notes where title='ClassLoader delegation'`).split('\n').filter((l) => l.includes('[')).join(' / '))

  // search
  await page.goto('http://127.0.0.1:4173/search')
  await page.fill('input[type=search]', 'delegation')
  await page.waitForSelector('mark')
  await shot(page, '08-search')
  log('search hit marks:', await page.locator('mark').allInnerTexts())

  // index
  await page.goto('http://127.0.0.1:4173/tags')
  await page.waitForSelector('text=java')
  await page.click('button[aria-label="Expand jvm"]')
  await shot(page, '09-index')

  // palette
  await page.goto('http://127.0.0.1:4173/')
  await page.waitForSelector('textarea[aria-label="Note text"]')
  await page.keyboard.press('Control+k')
  await page.waitForSelector('[role=combobox]')
  await page.keyboard.type('spring')
  await page.waitForSelector('[role=listbox] >> text=/Need to understand/', { timeout: 8000 })
  await shot(page, '10-palette')
  await page.keyboard.press('Escape')

  // inbox
  await page.goto('http://127.0.0.1:4173/inbox')
  await page.waitForSelector('text=What is it?')
  await shot(page, '11-inbox')

  // OFFLINE: type while offline, come back online
  await page.goto('http://127.0.0.1:4173/n/new')
  await page.waitForSelector('textarea[aria-label="Note text"]')
  await ctx.setOffline(true)
  await page.keyboard.type('written while the train was in a tunnel')
  await page.waitForSelector('text=/Offline — saved locally/', { timeout: 10000 })
  await shot(page, '12-offline')
  log('offline pill shown; rows in db meanwhile:', psql(`select count(*) from mneme.notes where content like 'written while%'`))
  await ctx.setOffline(false)
  for (let i = 0; i < 40 && psql(`select count(*) from mneme.notes where content like 'written while%'`) === '0'; i++) await page.waitForTimeout(500)
  log('after reconnect, rows in db:', psql(`select count(*) from mneme.notes where content like 'written while%'`))

  // dark theme
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.goto('http://127.0.0.1:4173/notes')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForSelector('text=ClassLoader delegation')
  await page.click('text=ClassLoader delegation'); await page.waitForSelector('text=Referenced by'); await page.waitForTimeout(400)
  await shot(page, '13-dark-note')
  await ctx.close()
}

// ----------------------------------------------------------------- mobile
{
  const { ctx, page } = await newCtx({ width: 390, height: 844 })
  await page.goto('http://127.0.0.1:4173/')
  await page.waitForSelector('h1:text("Today")')
  await page.waitForTimeout(500)
  await shot(page, '20-m-home')
  await page.goto('http://127.0.0.1:4173/notes'); await page.waitForSelector('section[aria-label="Notes"] >> text=JVM Memory'); await shot(page, '21-m-notes')
  await page.click('button[aria-label="Capture a new note"]')
  await page.waitForSelector('textarea[aria-label="Note text"]')
  await page.keyboard.type('mobile capture with a task\n- [ ] ')
  await shot(page, '22-m-editor')
  await page.goto('http://127.0.0.1:4173/tasks'); await page.waitForSelector('h1:text("Tasks")'); await page.waitForTimeout(500); await shot(page, '23-m-tasks')
  await ctx.close()
}

await browser.close()
console.log('\nBROWSER ERRORS:', errors.length ? '\n' + [...new Set(errors)].join('\n') : 'none')
