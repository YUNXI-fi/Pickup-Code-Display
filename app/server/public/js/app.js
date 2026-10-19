const listEl = document.getElementById('list')
const emptyEl = document.getElementById('empty')
const countBadge = document.getElementById('countBadge')
const statusBar = document.getElementById('statusBar')

const groupAddressBtn = document.getElementById('groupAddress')
const groupStatusBtn = document.getElementById('groupStatus')
const filterAllBtn = document.getElementById('filterAll')
const filterPendingBtn = document.getElementById('filterPending')
const filterPickedBtn = document.getElementById('filterPicked')
const countAll = document.getElementById('countAll')
const countPending = document.getElementById('countPending')
const countPicked = document.getElementById('countPicked')

let packages = []
let groupBy = 'address'
let filterStatus = 'all'

const groupColors = [
  'border-l-blue-500', 'border-l-emerald-500', 'border-l-amber-500',
  'border-l-violet-500', 'border-l-rose-500', 'border-l-cyan-500'
]

function timeAgo(t) {
  const diff = Date.now() - new Date(t).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  return `${h}小时前`
}

function isToday(dateStr) {
  if (!dateStr) return false
  return dateStr.startsWith(new Date().toISOString().slice(0, 10))
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function showStatus(msg, ok) {
  statusBar.textContent = msg
  statusBar.className = `fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm shadow-lg transition-opacity duration-300 ${ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`
  statusBar.classList.remove('hidden')
  statusBar.style.opacity = '1'
  setTimeout(() => {
    statusBar.style.opacity = '0'
    setTimeout(() => statusBar.classList.add('hidden'), 300)
  }, 1500)
}

function activateGroup(el) {
  ;[groupAddressBtn, groupStatusBtn].forEach(b => {
    b.classList.remove('bg-primary', 'text-white')
    b.classList.add('bg-white', 'text-gray-600')
  })
  el.classList.remove('bg-white', 'text-gray-600')
  el.classList.add('bg-primary', 'text-white')
}

function activateFilter(el) {
  ;[filterAllBtn, filterPendingBtn, filterPickedBtn].forEach(b => {
    b.classList.remove('bg-primary', 'text-white')
    b.classList.add('bg-white', 'text-gray-600')
  })
  el.classList.remove('bg-white', 'text-gray-600')
  el.classList.add('bg-primary', 'text-white')
}

groupAddressBtn.addEventListener('click', () => { groupBy = 'address'; activateGroup(groupAddressBtn); render() })
groupStatusBtn.addEventListener('click', () => { groupBy = 'status'; activateGroup(groupStatusBtn); render() })
filterAllBtn.addEventListener('click', () => { filterStatus = 'all'; activateFilter(filterAllBtn); render() })
filterPendingBtn.addEventListener('click', () => { filterStatus = 'pending'; activateFilter(filterPendingBtn); render() })
filterPickedBtn.addEventListener('click', () => { filterStatus = 'picked_up'; activateFilter(filterPickedBtn); render() })

function maskRecipient(name) {
  if (!name || name.length === 0) return ''
  if (name.length === 1) return name
  if (name.length === 2) return name[0] + '*'
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1]
}

function maskPhone(phone) {
  if (!phone || phone.length < 4) return phone || ''
  return phone.slice(-4)
}

function sortItems(items) {
  return items.sort((a, b) => {
    const da = a.pickup_code.match(/\d/)
    const db = b.pickup_code.match(/\d/)
    if (da && db) return da[0].localeCompare(db[0])
    if (da) return -1
    if (db) return 1
    return a.pickup_code.localeCompare(b.pickup_code, 'zh-CN')
  })
}

function renderItem(p, color) {
  const picked = p.status === 'picked_up'
  const platform = { taobao: '淘宝', pdd: '拼多多', manual: '手动' }[p.source_platform] || '手动'
  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-100 ${color || 'border-l-gray-300'} border-l-4 p-4 flex items-center justify-between hover:shadow-md transition-shadow ${picked ? 'opacity-65' : ''}" data-id="${p.id}">
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">${platform}</span>
          <span class="text-2xl font-mono font-bold tracking-widest ${picked ? 'text-gray-400' : 'text-gray-800'}">${escapeHtml(p.pickup_code)}</span>
          ${picked ? '<span class="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">已取件</span>' : ''}
        </div>
        <div class="mt-0.5 text-sm text-gray-500 truncate">
          ${p.recipient ? escapeHtml(maskRecipient(p.recipient)) : '未知收件人'}
          ${p.phone ? ` · ${escapeHtml(maskPhone(p.phone))}` : ''}
          ${picked && p.address ? ` · ${escapeHtml(p.address)}` : ''}
        </div>
      </div>
      <div class="flex items-center gap-3 flex-shrink-0 ml-3">
        <span class="text-xs text-gray-400">${timeAgo(picked ? (p.picked_up_at || p.created_at) : p.created_at)}</span>
        ${!picked
          ? `<button class="pickup-btn text-sm bg-primary text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors font-medium">取件</button>`
          : `<span class="text-sm text-gray-400 font-medium">已取件</span>`}
      </div>
    </div>
  `
}

function render() {
  const todayPicked = packages.filter(p => p.status === 'picked_up' && isToday(p.picked_up_at))
  let filtered = packages.filter(p => p.status === 'pending' || (p.status === 'picked_up' && isToday(p.picked_up_at)))
  if (filterStatus === 'pending') filtered = packages.filter(p => p.status === 'pending')
  else if (filterStatus === 'picked_up') filtered = todayPicked

  const pendingCount = packages.filter(p => p.status === 'pending').length
  const pickedCount = todayPicked.length
  countBadge.textContent = `待取件 ${pendingCount} · 已取件 ${pickedCount}`
  countAll.textContent = pendingCount + pickedCount
  countPending.textContent = pendingCount
  countPicked.textContent = pickedCount

  if (filtered.length === 0) {
    listEl.innerHTML = ''
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')

  if (groupBy === 'address') {
    const groups = {}
    for (const p of filtered) {
      const key = p.address || '其他'
      if (!groups[key]) groups[key] = []
      groups[key].push(p)
    }

    const sortedGroups = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))

    listEl.innerHTML = sortedGroups.map(([address, items], gi) => {
      sortItems(items)
      const color = groupColors[gi % groupColors.length]
      const pickedInGroup = items.filter(p => p.status === 'picked_up').length
      return `
        <div>
          <div class="flex items-center gap-2 mb-2">
            <span class="text-sm font-semibold text-gray-500">${escapeHtml(address)}</span>
            <span class="text-xs text-gray-400">${items.length}件${pickedInGroup ? `（${pickedInGroup}件已取）` : ''}</span>
          </div>
          <div class="space-y-2">
            ${items.map(p => renderItem(p, color)).join('')}
          </div>
        </div>
      `
    }).join('')

  } else {
    const pending = filtered.filter(p => p.status === 'pending')
    const picked = filtered.filter(p => p.status === 'picked_up')

    let html = ''
    if (pending.length > 0) {
      sortItems(pending)
      html += `
        <div>
          <div class="flex items-center gap-2 mb-2">
            <span class="text-sm font-semibold text-green-600">待取件</span>
            <span class="text-xs text-gray-400">${pending.length}件</span>
          </div>
          <div class="space-y-2">
            ${pending.map(p => renderItem(p, 'border-l-green-500')).join('')}
          </div>
        </div>
      `
    }
    if (picked.length > 0) {
      sortItems(picked)
      html += `
        <div class="${pending.length > 0 ? 'mt-6' : ''}">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-sm font-semibold text-gray-500">已取件</span>
            <span class="text-xs text-gray-400">${picked.length}件</span>
          </div>
          <div class="space-y-2">
            ${picked.map(p => renderItem(p, 'border-l-gray-300')).join('')}
          </div>
        </div>
      `
    }
    listEl.innerHTML = html
  }

  document.querySelectorAll('.pickup-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-id]').dataset.id
      try {
        const res = await fetch(`api/packages/${id}/pickup`, { method: 'PATCH' })
        if (!res.ok) throw new Error('取件失败')
        showStatus('已标记取件', true)
      } catch (e) {
        showStatus('操作失败', false)
      }
    })
  })
}

async function loadAll() {
  if (window._mainController) window._mainController.abort()
  window._mainController = new AbortController()
  try {
    const res = await fetch('api/packages?status=all', { signal: window._mainController.signal })
    packages = await res.json()
    render()
  } catch (e) {
    if (e.name !== 'AbortError') showStatus('加载数据失败', false)
  }
}

const evtSource = new EventSource('api/events')

evtSource.addEventListener('create', e => {
  const p = JSON.parse(e.data)
  packages.unshift(p)
  render()
  // 待发货/运输中不入取件提醒，仅到驿站（待取件）才提示
  if (p.status === 'pending') showStatus(`新包裹 ${p.pickup_code} 已到达`, true)
})

evtSource.addEventListener('update', e => {
  const p = JSON.parse(e.data)
  const idx = packages.findIndex(x => x.id === p.id)
  if (idx !== -1) packages[idx] = p
  else packages.unshift(p)
  render()
})

evtSource.addEventListener('delete', e => {
  const p = JSON.parse(e.data)
  packages = packages.filter(x => x.id !== p.id)
  render()
})

evtSource.onerror = () => {
  showStatus('实时连接已断开，正在重连...', false)
}

loadAll()

addEventListener('beforeunload', () => {
  if (window._mainController) window._mainController.abort()
  evtSource.close()
})
