const fs = require('fs')
const path = require('path')

const BLOCKLIST_PATH = process.env.BLOCKLIST_PATH ||
  path.join(__dirname, '..', 'data', 'blocklist.json')

function load() {
  try {
    return new Set(JSON.parse(fs.readFileSync(BLOCKLIST_PATH, 'utf8')))
  } catch (_) {
    return new Set()
  }
}

function save(set) {
  const dir = path.dirname(BLOCKLIST_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(BLOCKLIST_PATH, JSON.stringify([...set], null, 2))
}

function getAll() {
  return [...load()]
}

function isBlocked(email) {
  if (!email) return false
  return load().has(email.toLowerCase().trim())
}

function addEmails(emails) {
  const set = load()
  let added = 0
  for (const email of emails) {
    const normalized = email.toLowerCase().trim()
    if (normalized && !set.has(normalized)) {
      set.add(normalized)
      added++
    }
  }
  save(set)
  return added
}

function removeEmail(email) {
  const set = load()
  const normalized = email.toLowerCase().trim()
  if (!set.has(normalized)) return false
  set.delete(normalized)
  save(set)
  return true
}

module.exports = { getAll, isBlocked, addEmails, removeEmail }
