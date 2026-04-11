const state = {
  activeTable: 'emails',
  data: {
    emails: [],
    domains: [],
    keywords: [],
    repliesKeywords: [],
  },
  search: '',
}

const elements = {
  tabs: [...document.querySelectorAll('.tab')],
  entriesBody: document.getElementById('entries-body'),
  emptyStateTemplate: document.getElementById('empty-state-template'),
  statusBanner: document.getElementById('status-banner'),
  refreshButton: document.getElementById('refresh-button'),
  addForm: document.getElementById('add-form'),
  searchInput: document.getElementById('search-input'),
  metrics: {
    emails: document.getElementById('metric-emails'),
    domains: document.getElementById('metric-domains'),
  },
}

function parseList(value) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function showStatus(message, tone = 'success') {
  elements.statusBanner.hidden = false
  elements.statusBanner.dataset.tone = tone
  elements.statusBanner.textContent = message
}

function hideStatus() {
  elements.statusBanner.hidden = true
  elements.statusBanner.textContent = ''
  delete elements.statusBanner.dataset.tone
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.message || `Request failed with ${response.status}`)
  }

  return data
}

function filteredEntries() {
  const entries = state.data[state.activeTable] || []
  if (!state.search) return entries
  const term = state.search.toLowerCase()
  return entries.filter((entry) => entry.toLowerCase().includes(term))
}

function updateMetrics() {
  elements.metrics.emails.textContent = String((state.data.emails || []).length)
  elements.metrics.domains.textContent = String((state.data.domains || []).length)
}

function renderTable() {
  const entries = filteredEntries()
  elements.entriesBody.innerHTML = ''

  if (!entries.length) {
    elements.entriesBody.appendChild(elements.emptyStateTemplate.content.cloneNode(true))
    return
  }

  for (const value of entries) {
    const row = document.createElement('tr')
    row.innerHTML = `
      <td class="entry-value"></td>
      <td><button type="button" class="remove-button">Remove</button></td>
    `
    row.querySelector('.entry-value').textContent = value
    row.querySelector('.remove-button').addEventListener('click', async () => {
      try {
        await request(`/dashboard/api/blocklist/${state.activeTable}`, {
          method: 'DELETE',
          body: JSON.stringify({ ids: [value] }),
        })
        state.data[state.activeTable] = state.data[state.activeTable].filter((entry) => entry !== value)
        updateMetrics()
        renderTable()
        showStatus(`Removed 1 entry from ${state.activeTable}.`)
      } catch (error) {
        showStatus(error.message, 'error')
      }
    })
    elements.entriesBody.appendChild(row)
  }
}

function setActiveTab(table) {
  state.activeTable = table
  for (const tab of elements.tabs) {
    tab.classList.toggle('is-active', tab.dataset.table === table)
  }
  renderTable()
}

async function loadBlocklist({ silent = false } = {}) {
  if (!silent) hideStatus()
  try {
    const response = await request('/dashboard/api/blocklist')
    state.data = response.data
    updateMetrics()
    renderTable()
  } catch (error) {
    showStatus(error.message, 'error')
  }
}

elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => setActiveTab(tab.dataset.table))
})

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value.trim()
  renderTable()
})

elements.refreshButton.addEventListener('click', () => loadBlocklist())

elements.addForm.addEventListener('submit', async (event) => {
  event.preventDefault()

  const payload = {
    emails: parseList(document.getElementById('input-emails').value),
    domains: parseList(document.getElementById('input-domains').value),
    keywords: parseList(document.getElementById('input-keywords').value),
    repliesKeywords: parseList(document.getElementById('input-repliesKeywords').value),
  }

  const totalEntries = Object.values(payload).reduce((sum, items) => sum + items.length, 0)
  if (!totalEntries) {
    showStatus('Add at least one email, domain, keyword, or reply keyword.', 'error')
    return
  }

  try {
    const response = await request('/dashboard/api/blocklist/add', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    state.data = response.data
    updateMetrics()
    renderTable()
    elements.addForm.reset()
    showStatus(`Added ${response.added} new blocklist entr${response.added === 1 ? 'y' : 'ies'}.`)
  } catch (error) {
    showStatus(error.message, 'error')
  }
})

loadBlocklist({ silent: true })
