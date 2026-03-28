require('dotenv').config()
const express = require('express')
const { getToken } = require('./auth')

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

// Proxy all /api/v1/* requests
app.all('/api/v1/*', async (req, res) => {
  try {
    const token = await getToken()

    // Build target URL
    const normalizedPath = normalizeReachInboxPath(req.path)
    const targetUrl = `${REACHINBOX_BASE}${normalizedPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`

    // Forward headers (strip host/connection)
    const forwardHeaders = {}
    const skipHeaders = ['host', 'connection', 'transfer-encoding', 'content-length', 'authorization']
    for (const [key, val] of Object.entries(req.headers)) {
      if (!skipHeaders.includes(key.toLowerCase())) forwardHeaders[key] = val
    }

    // Inject auth cookie
    const existingCookie = forwardHeaders['cookie'] || ''
    const authCookie = `auth_token=${token}`
    forwardHeaders['cookie'] = existingCookie
      ? `${existingCookie}; ${authCookie}`
      : authCookie

    // Determine body
    let body = undefined
    if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && req.body && req.body.length > 0) {
      body = req.body
      if (!forwardHeaders['content-length']) {
        forwardHeaders['content-length'] = req.body.length
      }
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
      const retry = await fetch(targetUrl, { method: req.method, headers: forwardHeaders, body, redirect: 'follow' })
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
  // Validate token on startup
  getToken().then(() => console.log('[auth] Token ready')).catch(e => console.error('[auth] Token error:', e.message))
})
