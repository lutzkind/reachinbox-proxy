require('dotenv').config()
const express = require('express')
const crypto = require('crypto')
const path = require('path')
const { getToken } = require('./auth')
const { getUpstreamProxyAgent } = require('./proxy')
const blocklist = require('./blocklist')

const app = express()
const PORT = process.env.PORT || 3000
const REACHINBOX_BASE = 'https://app.reachinbox.ai'
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || ''
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || ''
const DASHBOARD_ENABLED = Boolean(DASHBOARD_USERNAME && DASHBOARD_PASSWORD)

function normalizeReachInboxPath(pathname) {
  if (pathname === '/api/v1/campaigns/all') return '/api/v1/campaign/list'
  if (pathname.startsWith('/api/v1/campaigns/')) {
    return pathname.replace('/api/v1/campaigns/', '/api/v1/campaign/')
  }
  return pathname
}

function parseJsonBody(req) {
  try {
    return JSON.parse(req.body?.toString?.() || '{}')
  } catch (_) {
    return {}
  }
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  if (leftBuffer.length !== rightBuffer.length) return false
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_ENABLED) {
    return res.status(404).send('Dashboard is not enabled.')
  }

  const header = req.headers.authorization || ''
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="ReachInbox Dashboard"')
    return res.status(401).send('Authentication required.')
  }

  let decoded = ''
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch (_) {
    res.set('WWW-Authenticate', 'Basic realm="ReachInbox Dashboard"')
    return res.status(401).send('Invalid authorization header.')
  }

  const separatorIndex = decoded.indexOf(':')
  const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : ''
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : ''

  if (!secureEqual(username, DASHBOARD_USERNAME) || !secureEqual(password, DASHBOARD_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="ReachInbox Dashboard"')
    return res.status(401).send('Invalid credentials.')
  }

  next()
}

// Parse raw body for proxying (preserve exact payload)
app.use(express.raw({ type: '*/*', limit: '50mb' }))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'reachinbox-proxy' }))

// ── Dashboard UI ──────────────────────────────────────────────────────────────

app.get('/dashboard', requireDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'))
})

app.get('/dashboard/styles.css', requireDashboardAuth, (req, res) => {
  res.type('text/css').sendFile(path.join(__dirname, 'dashboard.css'))
})

app.get('/dashboard/app.js', requireDashboardAuth, (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'dashboard.js'))
})

app.get('/dashboard/api/blocklist', requireDashboardAuth, (req, res) => {
  res.json({ status: 200, data: blocklist.getAll() })
})

app.post('/dashboard/api/blocklist/add', requireDashboardAuth, (req, res) => {
  const body = parseJsonBody(req)
  const added = blocklist.addEntries({
    emails: Array.isArray(body.emails) ? body.emails : [],
    domains: Array.isArray(body.domains) ? body.domains : [],
    keywords: Array.isArray(body.keywords) ? body.keywords : [],
    repliesKeywords: Array.isArray(body.repliesKeywords) ? body.repliesKeywords : [],
  })

  res.json({
    status: 200,
    message: 'Blocklist updated successfully',
    added,
    data: blocklist.getAll(),
  })
})

app.delete('/dashboard/api/blocklist/:table', requireDashboardAuth, (req, res) => {
  const { table } = req.params
  const body = parseJsonBody(req)
  const ids = Array.isArray(body.ids) ? body.ids : []
  const removed = blocklist.deleteEntries(table, ids)

  res.json({
    status: 200,
    message: `Removed ${removed} entries from ${table}`,
    removed,
    data: blocklist.getAll(),
  })
})

// ── Blocklist endpoints (mirrors official api.reachinbox.ai shape) ────────────

// GET /api/v1/blocklist/:table? — list blocklist entries
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

// POST /api/v1/blocklist/add — add entries
app.post('/api/v1/blocklist/add', (req, res) => {
  const body = parseJsonBody(req)
  const { emails = [], domains = [], keywords = [], repliesKeywords = [] } = body
  if (!emails.length && !domains.length && !keywords.length && !repliesKeywords.length) {
    return res.status(400).json({ status: 400, message: 'Provide at least one of: emails, domains, keywords, repliesKeywords' })
  }
  const added = blocklist.addEntries({ emails, domains, keywords, repliesKeywords })
  res.json({ status: 200, message: 'Blacklist updated successfully', added })
})

// DELETE /api/v1/blocklist/:table — remove entries by value
app.delete('/api/v1/blocklist/:table', (req, res) => {
  const body = parseJsonBody(req)
  const { ids = [] } = body
  const { table } = req.params
  if (!ids.length) return res.status(400).json({ status: 400, message: 'Provide ids array' })
  const removed = blocklist.deleteEntries(table, ids)
  res.json({ status: 200, message: `Removed ${removed} entries from ${table}` })
})

// ── ReachInbox webhook receiver ───────────────────────────────────────────────

// POST /webhook/reachinbox — receives LEAD_NOT_INTERESTED and EMAIL_BOUNCED events
// and auto-adds the lead email to the blocklist
app.post('/webhook/reachinbox', (req, res) => {
  // Optional secret validation — set WEBHOOK_SECRET in env to enable
  const secret = process.env.WEBHOOK_SECRET
  if (secret) {
    const provided = req.headers['x-webhook-secret'] || req.headers['x-reachinbox-secret'] || ''
    if (provided !== secret) {
      console.warn('[webhook] Rejected: invalid secret')
      return res.status(401).json({ status: 401, message: 'Unauthorized' })
    }
  }

  const body = parseJsonBody(req)

  const event = body.event || body.type || ''
  // Try multiple payload shapes ReachInbox may send
  const lead = body.lead || body.data?.lead || body.data || {}
  const email = (lead.email || body.email || '').toLowerCase().trim()

  const autoBlockEvents = ['LEAD_NOT_INTERESTED', 'EMAIL_BOUNCED']
  if (!autoBlockEvents.includes(event.toUpperCase())) {
    return res.json({ status: 200, message: `Event ${event} received, no action taken` })
  }

  if (!email) {
    // Log full payload so we can diagnose unexpected formats
    console.warn(`[webhook] ${event} received but no email found. Payload: ${JSON.stringify(body)}`)
    return res.status(200).json({ status: 200, message: 'No email in payload, ignored' })
  }

  const added = blocklist.addEntries({ emails: [email] })
  console.log(`[webhook] Auto-blocklisted ${email} (event: ${event}, added: ${added})`)
  res.json({ status: 200, message: `Blocklisted ${email}`, added })
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

      // Intercept leads-add: strip blocked emails/domains before forwarding.
      // Applies to both campaign leads and lead list imports.
      const isLeadsAdd = /\/api\/v1\/campaign\/\d+\/leads$/.test(normalizedPath)
        || normalizedPath === '/api/v1/leads-list/add-leads'
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

    // Auto-subscribe webhooks for newly created campaigns
    const isCampaignCreate = req.method === 'POST' && /^\/api\/v1\/campaign$/.test(normalizedPath)
    if (isCampaignCreate && upstream.status >= 200 && upstream.status < 300) {
      try {
        const responseBuf = await upstream.buffer()
        const responseJson = JSON.parse(responseBuf.toString())
        const campaignId = responseJson?.data?.id || responseJson?.id
        if (campaignId) {
          const webhookBase = process.env.COOLIFY_URL || 'https://reachinbox.luxeillum.com'
          const callbackUrl = `${webhookBase}/webhook/reachinbox`
          for (const event of ['LEAD_NOT_INTERESTED', 'EMAIL_BOUNCED']) {
            fetch(`${REACHINBOX_BASE}/api/v1/webhook/subscribe`, {
              method: 'POST',
              headers: { ...forwardHeaders, 'content-type': 'application/json' },
              body: JSON.stringify({ campaignId, event, callbackUrl }),
              agent: getUpstreamProxyAgent(),
            }).then(r => console.log(`[webhook] Auto-subscribed ${event} for campaign ${campaignId}: ${r.status}`))
              .catch(e => console.error(`[webhook] Auto-subscribe failed for campaign ${campaignId}: ${e.message}`))
          }
        }
        res.status(upstream.status)
        upstream.headers.forEach((val, key) => {
          if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) res.set(key, val)
        })
        return res.send(responseBuf)
      } catch (_) { /* fall through to normal response handling */ }
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
