const fetch = require('node-fetch')
const { getUpstreamProxyAgent } = require('./proxy')

const REACHINBOX_URL = 'https://app.reachinbox.ai'

let cachedToken = process.env.REACHINBOX_TOKEN || null
let tokenExpiry = process.env.REACHINBOX_TOKEN_EXPIRY ? parseInt(process.env.REACHINBOX_TOKEN_EXPIRY) : null
let cachedCookieHeader = process.env.REACHINBOX_COOKIE || null

function isTokenValid() {
  if (!cachedToken) return false
  if (!tokenExpiry) return true // assume valid if no expiry known
  return Date.now() / 1000 < tokenExpiry - 60 // 60s buffer
}

async function refreshTokenViaLogin() {
  console.log('[auth] Refreshing token via login...')
  const res = await fetch(`${REACHINBOX_URL}/api/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.REACHINBOX_EMAIL,
      password: process.env.REACHINBOX_PASSWORD,
    }),
    agent: getUpstreamProxyAgent(),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Login failed: ${res.status} ${body}`)
  }

  // Extract auth_token and preserve the full cookie jar from the login response
  const setCookie = res.headers.raw()['set-cookie'] || []
  let token = null
  const cookies = []
  for (const cookie of setCookie) {
    const cookiePair = cookie.split(';', 1)[0]
    if (cookiePair) cookies.push(cookiePair)
    const match = cookie.match(/auth_token=([^;]+)/)
    if (match) { token = match[1]; break }
  }

  // Fallback: check response body
  if (!token) {
    const data = await res.json()
    token = data?.data?.token || data?.token || null
  }

  if (!token) throw new Error('Could not extract auth_token from login response')

  // Decode expiry from JWT
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    tokenExpiry = payload.exp
    console.log(`[auth] Token refreshed, expires: ${new Date(tokenExpiry * 1000).toISOString()}`)
  } catch {
    tokenExpiry = null
  }

  cachedToken = token
  cachedCookieHeader = cookies.length > 0 ? cookies.join('; ') : `auth_token=${token}`
  return token
}

async function getToken() {
  if (isTokenValid()) return cachedToken
  return refreshTokenViaLogin()
}

function getCookieHeader() {
  if (cachedCookieHeader) return cachedCookieHeader
  if (cachedToken) return `auth_token=${cachedToken}`
  return null
}

module.exports = { getToken, getCookieHeader, refreshTokenViaLogin }
