// supabase-js talks to <url>/rest/v1/...; a bare PostgREST serves at the root.
// This 20-line proxy strips the prefix so the REAL client code can run against a local PostgREST.
import http from 'node:http'

const [, , listen = '54331', upstream = '54330'] = process.argv
http.createServer((req, res) => {
  const path = (req.url ?? '/').replace(/^\/rest\/v1/, '') || '/'
  const up = http.request({ host: '127.0.0.1', port: Number(upstream), path, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers)
    r.pipe(res)
  })
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)) })
  req.pipe(up)
}).listen(Number(listen), '127.0.0.1', () => console.log(`rest proxy :${listen} -> :${upstream}`))
