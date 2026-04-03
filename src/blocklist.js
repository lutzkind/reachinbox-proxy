const fs = require('fs')
const path = require('path')

const BLOCKLIST_PATH = process.env.BLOCKLIST_PATH ||
  path.join(__dirname, '..', 'data', 'blocklist.json')

function load() {
  try {
    return JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8'))
  } catch (_) {
    return { emails: [], domains: [], keywords: [], repliesKeywords: [] }
  }
}

function save(data) {
  const dir = path.dirname(BLOCKLIST_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(BLOCKLIST_PATH, JSON.stringify(data, null, 2))
}

function getAll() {
  return load()
}

function addEntries({ emails = [], domains = [], keywords = [], repliesKeywords = [] }) {
  const data = load()
  let added = 0
  for (const email of emails) {
    const n = email.toLowerCase().trim()
    if (n && !data.emails.includes(n)) { data.emails.push(n); added++ }
  }
  for (const domain of domains) {
    const n = domain.toLowerCase().trim()
    if (n && !data.domains.includes(n)) { data.domains.push(n); added++ }
  }
  for (const kw of keywords) {
    if (kw && !data.keywords.includes(kw)) { data.keywords.push(kw); added++ }
  }
  for (const kw of repliesKeywords) {
    if (kw && !data.repliesKeywords.includes(kw)) { data.repliesKeywords.push(kw); added++ }
  }
  save(data)
  return added
}

function deleteEntries(table, ids) {
  const data = load()
  if (!data[table]) return 0
  const before = data[table].length
  data[table] = data[table].filter(entry => !ids.includes(entry))
  save(data)
  return before - data[table].length
}

function isBlocked(email) {
  if (!email) return false
  const data = load()
  const normalizedEmail = email.toLowerCase().trim()
  if (data.emails.includes(normalizedEmail)) return true
  const domain = normalizedEmail.split('@')[1]
  if (domain && data.domains.includes(domain)) return true
  return false
}

module.exports = { getAll, addEntries, deleteEntries, isBlocked }
