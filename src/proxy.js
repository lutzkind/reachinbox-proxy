const { HttpsProxyAgent } = require('https-proxy-agent')

let cachedProxyUrl = null
let cachedProxyAgent = null

function normalizeProxyUrl(rawProxy) {
  if (!rawProxy) return null

  const trimmed = String(rawProxy).trim()
  if (!trimmed) return null

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) {
    return trimmed
  }

  const parts = trimmed.split(':')
  if (parts.length === 4) {
    const [host, port, username, password] = parts
    return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`
  }

  if (parts.length === 2) {
    const [host, port] = parts
    return `http://${host}:${port}`
  }

  throw new Error(`Invalid proxy format: ${rawProxy}`)
}

function getConfiguredProxyUrl() {
  return (
    process.env.REACHINBOX_UPSTREAM_PROXY ||
    process.env.REACHINBOX_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    null
  )
}

function getUpstreamProxyAgent() {
  const rawProxy = getConfiguredProxyUrl()
  if (!rawProxy) return undefined

  const proxyUrl = normalizeProxyUrl(rawProxy)
  if (!proxyUrl) return undefined

  if (!cachedProxyAgent || cachedProxyUrl !== proxyUrl) {
    cachedProxyUrl = proxyUrl
    cachedProxyAgent = new HttpsProxyAgent(proxyUrl)
    console.log(`[proxy] Using upstream proxy: ${proxyUrl.replace(/:\/\/.*@/, '://***:***@')}`)
  }

  return cachedProxyAgent
}

module.exports = {
  getUpstreamProxyAgent,
  normalizeProxyUrl,
}
