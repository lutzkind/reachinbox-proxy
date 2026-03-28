require('dotenv').config()
const express = require('express')
const { getToken } = require('./auth')

const app = express()
const PORT = process.env.PORT || 3000
const REACHINBOX_BASE = 'https://app.reachinbox.ai'
const CHALLENGE_RE = /Just a moment|Enable JavaScript and cookies to continue|cf-mitigated|cloudflare/i

function normalizeReachInboxPath(pathname) {
  if (pathname === '/api/v1/campaigns/all') return '/api/v1/campaign/list'
  if (pathname.startsWith('/api/v1/campaigns/')) {
    return pathname.replace('/api/v1/campaigns/', '/api/v1/campaign/')
  }
  return pathname
}

function serializeResponseHeaders(headers) {
  const result = {}
  headers.forEach((val, key) => {
    if (!['transfer-encoding', 'connection', 'content-encoding'].includes(key.toLowerCase())) {
      result[key] = val
    }
  })
  return result
}

function sanitizeForwardHeaders(headers) {
  const result = {}
  const skipHeaders = new Set(['host', 'connection', 'transfer-encoding', 'content-length', 'authorization'])
  for (const [key, val] of Object.entries(headers)) {
    if (!skipHeaders.has(key.toLowerCase())) result[key] = val
  }
  return result
}

function sanitizeBrowserHeaders(headers) {
  const result = {}
  const skipHeaders = new Set(['host', 'connection', 'transfer-encoding', 'content-length', 'authorization', 'cookie'])
  for (const [key, val] of Object.entries(headers)) {
    if (!skipHeaders.has(key.toLowerCase())) result[key] = val
  }
  return result
}

async function fetchViaBrowser(targetUrl, method, headers, bodyBuffer) {
  let chromium
  try {
    ;({ chromium } = require('playwright'))
  } catch (err) {
    throw new Error(`Playwright is unavailable for Cloudflare fallback: ${err.message}`)
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  try {
    const context = await browser.newContext({
      userAgent:
        headers['user-agent'] ||
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        accept: headers.accept || 'application/json',
        'accept-language': headers['accept-language'] || 'en-US,en;q=0.9',
      },
    })

    const page = await context.newPage()
    await page.goto(REACHINBOX_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(5000)

    const result = await page.evaluate(async ({ targetUrl, method, headers, body }) => {
      const response = await fetch(targetUrl, {
        method,
        headers,
        body,
        credentials: 'include',
      })
      const text = await response.text()
      const responseHeaders = {}
      response.headers.forEach((val, key) => {
        responseHeaders[key] = val
      })
      return {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        text,
      }
    }, {
      targetUrl,
      method,
      headers,
      body: bodyBuffer ? bodyBuffer.toString('utf8') : undefined,
    })

    await context.close()
    return result
  } finally {
    await browser.close()
  }
}

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
    const cookieHeader = require('./auth').getCookieHeader()

    // Build target URL
    const normalizedPath = normalizeReachInboxPath(req.path)
    const targetUrl = `${REACHINBOX_BASE}${normalizedPath}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`

    // Forward headers (strip hop-by-hop headers)
    const forwardHeaders = sanitizeForwardHeaders(req.headers)

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

    const upstreamText = await upstream.text()
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

    // Cloudflare challenge fallback: open the site in a browser context and replay the request
    if (upstream.status === 403 && CHALLENGE_RE.test(upstreamText)) {
      console.log('[proxy] Got Cloudflare challenge, retrying through Playwright...')
      const browserResult = await fetchViaBrowser(
        targetUrl,
        req.method,
        sanitizeBrowserHeaders(forwardHeaders),
        body
      )

      res.status(browserResult.status)
      Object.entries(browserResult.headers || {}).forEach(([key, val]) => res.set(key, val))
      return res.send(browserResult.text)
    }

    // Stream response back
    res.status(upstream.status)
    Object.entries(serializeResponseHeaders(upstream.headers)).forEach(([key, val]) => res.set(key, val))
    res.send(Buffer.from(upstreamText))

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
