require('dotenv').config()
const express = require('express')
const { getToken } = require('./auth')
const { getUpstreamProxyAgent } = require('./proxy')
const blocklist = require('./blocklist')

const app = express()
const PORT = process.env.PORT || 3000
const REACHINBOX_BASE = 'https://app.reachinbox.ai'

function normalizeReachInboxPath(pathname) {
  if (pathname === '/api/v1/campaigns/all') return '/api/v1/campaign/list'
  if (pathname.startsWith('/api/v1/campaigns/')) {
    return pathname.replace('/api/v1/campaigns/', '/api/v1/campaign/')
  }
  return pathname
}

// Parse raw body for proxying (preserve exact payload)
app.use(express.raw({ type: '*/*', limit: '50mb' }))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'reachinbox-proxy' }))

// ── Blocklist endpoints (mirrors official api.reachinbox.ai shape) ────────────

// GET /api/v1/blocklist/:table? — list blocklist entries
// :table = emails | domains | keywords | repliesKeywords (omit for all)
app.get('/api/v1/blocklist/:table?', (req, res) => {
  const data = blocklist.getAll()
  const { table } = req.params
  const { limit, offset = 0, q } = req.query

  if (table && !data[table]) {
    return res.status(400).json({ status: 400, message: `Unknown table: ${table}. Use emails, domains, keywords, repliesKeywords.` })
  }

  let entries = table ? data[table] : data
  if (table) {
    if (q) entries = entries.filter(e => e.includes(q))
    if (offset) entries = entries.slice(Number(offset))
    if (limit) entries = entries.slice(0, Number(limit))
    return res.json({ status: 200, data: entries, total: entries.length })
  }

  res.json({ status: 200, data })
})

// POST /api/v1/blocklist/add — add entries (mirrors official API exactly)
// Body: { emails?, domains?, keywords?, repliesKeywords? }
app.post('/api/v1/blocklist/add', (req, res) => {
  let body = {}
  try { body = JSON.parse(req.body.toString()) } catch (_) {}
  const { emails = [], domains = [], keywords = [], repliesKeywords = [] } = body
  if (!emails.length && !domains.length && !keywords.length && !repliesKeywords.length) {
    return res.status(400).json({ status: 400, message: 'Provide at least one of: emails, domains, keywords, repliesKeywords' })
  }
  const added = blocklist.addEntries({ emails, domains, keywords, repliesKeywords })
  res.json({ status: 200, message: 'Blacklist updated successfully', added })
})

// DELETE /api/v1/blocklist/:table — remove entries by value
// Body: { ids: ["email@example.com", ...] }
app.delete('/api/v1/blocklist/:table', (req, res) => {
  let body = {}
  try { body = JSON.parse(req.body.toString()) } catch (_) {}
  const { ids = [] } = body
  const { table } = req.params
  if (!ids.length) return res.status(400).json({ status: 400, message: 'Provide ids array' })
  const removed = blocklist.deleteEntries(table, ids)
  res.json({ status: 200, message: `Removed ${removed} entries from ${table}` })
})

// ── Generic proxy ─────────────────────────────────────────────────────────────

app.all('/api/v1/*', async (req, res) => {
  try {
    const token = await getToken()
    const cookieHeader = require('./auth').getCookieHeader()

    // Build target URL
    const normalizedPath = normalizeReachInboxPath(req.path)
    const targetUrl = `${REACHINBOX_BASE}${normalizedPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`

    // Forward headers (strip host/connection)
    const forwardHeaders = {}
    const skipHeaders = ['host', 'connection', 'transfer-encoding', 'content-length', 'authorization', 'user-agent']
    for (const [key, val] of Object.entries(req.headers)) {
      if (!skipHeaders.includes(key.toLowerCase())) forwardHeaders[key] = val
    }
    forwardHeaders['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

    // Inject auth cookie
    const existingCookie = forwardHeaders['cookie'] || ''
    const authCookie = `auth_token=${token}`
    forwardHeaders['cookie'] = existingCookie
      ? `${existingCookie}; ${authCookie}`
      : authCookie
    if (cookieHeader) {
      forwardHeaders['cookie'] = existingCookie
        ? `${existingCookie}; ${cookieHeader}`
        : cookieHeader
    }
    forwardHeaders['authorization'] = `Bearer ${token}`

    // Determine body
    let body = undefined
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && req.body && req.body.length > 0) {
      body = req.body

      // Intercept leads-add: strip blocked emails/domains before forwarding
      const isLeadsAdd = /\/api\/v1\/campaign\/\d+\/leads$/.test(normalizedPath)
      if (isLeadsAdd) {
        try {
          const parsed = JSON.parse(req.body.toString())
          if (Array.isArray(parsed.leads)) {
            const before = parsed.leads.length
            parsed.leads = parsed.leads.filter(l => !blocklist.isBlocked(l.email))
            const dropped = before - parsed.leads.length
            if (dropped > 0) console.log(`[blocklist] Dropped ${dropped} blocked lead(s) from leads-add`)
            if (parsed.leads.length === 0) {
              return res.json({ status: 200, message: 'All leads were on the blocklist — none forwarded.', blocked: before })
            }
            body = Buffer.from(JSON.stringify(parsed))
          }
        } catch (_) { /* not valid JSON, pass through as-is */ }
      }

      forwardHeaders['content-length'] = body.length
    }

    console.log(`[proxy] ${req.method} ${targetUrl}`)

    const fetch = require('node-fetch')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    let upstream
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body,
        redirect: 'follow',
        signal: controller.signal,
        agent: getUpstreamProxyAgent(),
      })
    } finally {
      clearTimeout(timeout)
    }

    console.log(`[proxy] ${req.method} ${targetUrl} -> ${upstream.status}`)

    // If 401, try token refresh once
    if (upstream.status === 401) {
      console.log('[proxy] Got 401, forcing token refresh...')
      const { refreshTokenViaLogin } = require('./auth')
      const newToken = await refreshTokenViaLogin()
      forwardHeaders['cookie'] = `auth_token=${newToken}`
      const retry = await fetch(targetUrl, {
        method: req.method,
        headers: forwardHeaders,
        body,
        redirect: 'follow',
        agent: getUpstreamProxyAgent(),
      })
      res.status(retry.status)
      retry.headers.forEach((val, key) => {
        if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) res.set(key, val)
      })
      const retryBuf = await retry.buffer()
      return res.send(retryBuf)
    }

    // Stream response back
    res.status(upstream.status)
    upstream.headers.forEach((val, key) => {
      if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) res.set(key, val)
    })
    const buf = await upstream.buffer()
    res.send(buf)

  } catch (err) {
    console.error('[proxy] Error:', err.message)
    res.status(502).json({ status: 502, message: `Proxy error: ${err.message}` })
  }
})

// Catch-all 404
app.use((req, res) => res.status(404).json({ status: 404, message: 'Not found. Use /api/v1/* endpoints.' }))

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ReachInbox proxy running on port ${PORT}`)
  console.log(`Proxying to: ${REACHINBOX_BASE}/api/v1/`)
  getToken().then(() => console.log('[auth] Token ready')).catch(e => console.error('[auth] Token error:', e.message))
})
