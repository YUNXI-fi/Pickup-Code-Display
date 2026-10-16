const listEl = document.getElementById('list')
const emptyEl = document.getElementById('empty')
const statusBar = document.getElementById('statusBar')
const addForm = document.getElementById('addForm')
const filterAll = document.getElementById('filterAll')
const filterToShip = document.getElementById('filterToShip')
const filterShipping = document.getElementById('filterShipping')
const filterPending = document.getElementById('filterPending')
const filterPicked = document.getElementById('filterPicked')

let packages = []
let filterStatus = 'all'

function getSession() {
  try {
    var s = JSON.parse(localStorage.getItem('admin_session') || '{}')
    if (s.pw && s.expiresAt > Date.now()) return s.pw
  } catch(e) {}
  return null
}

const params = new URLSearchParams(window.location.search)
if (params.get('pw')) {
  // ponytail: always re-save to refresh expiry, not just when pw differs
  localStorage.setItem('admin_session', JSON.stringify({ pw: params.get('pw'), expiresAt: Date.now() + 12 * 3600000 }))
  window.history.replaceState({}, '', window.location.pathname)
}
function authHeaders() {
  const pw = getSession()
  return pw ? { 'x-admin-password': pw } : {}
}
function authFetch(url, opts = {}) {
  opts.headers = { ...opts.headers, ...authHeaders() }
  return fetch(url, opts)
}

const autoCompleteDropdowns = []

function initAutocomplete(input) {
  const field = input.name
  const wrapper = document.createElement('div')
  wrapper.className = 'relative'
  input.parentNode.insertBefore(wrapper, input)
  wrapper.appendChild(input)

  const dropdown = document.createElement('div')
  dropdown.className = 'absolute top-full left-0 right-0 z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto hidden'
  wrapper.appendChild(dropdown)
  autoCompleteDropdowns.push(dropdown)

  async function fetchSuggestions() {
    try {
      const res = await fetch(`api/history?field=${field}`)
      if (!res.ok) return []
      return await res.json()
    } catch (e) { return [] }
  }

  async function showDropdown() {
    if (input.value.trim() !== '') {
      dropdown.classList.add('hidden')
      return
    }
    for (const d of autoCompleteDropdowns) {
      if (d !== dropdown) d.classList.add('hidden')
    }
    const items = await fetchSuggestions()
    if (items.length === 0) {
      dropdown.classList.add('hidden')
      return
    }

    dropdown.innerHTML = items.slice(0, 10).map(item => `
      <div class="px-4 py-2 text-sm text-gray-700 cursor-pointer hover:bg-gray-100" data-value="${escapeHtml(item.value)}">
        ${escapeHtml(item.value)}
      </div>
    `).join('')
    dropdown.classList.remove('hidden')

    dropdown.querySelectorAll('div').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault()
        input.value = el.dataset.value
        dropdown.classList.add('hidden')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    })
  }

  input.addEventListener('focus', showDropdown)
  input.addEventListener('input', () => {
    if (document.activeElement !== input) return
    if (input.value.trim() === '') showDropdown()
    else dropdown.classList.add('hidden')
  })
  input.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('hidden'), 200)
  })
}

document.querySelectorAll('input[name="recipient"], input[name="phone"], input[name="address"]').forEach(initAutocomplete)

const submitBtn = document.getElementById('submitBtn')
const imageInput = document.getElementById('imageInput')
const recognizedEl = document.getElementById('recognizedPackages')

const REQUIRED_FIELDS = [
  { name: 'pickup_code', label: '取件码' },
  { name: 'recipient', label: '收件人' },
  { name: 'phone', label: '手机尾号' },
  { name: 'address', label: '取件地址' },
]

let recognizedPackages = []
let activeRecognizedIndex = -1

function validateForm() {
  const missing = []
  for (const field of REQUIRED_FIELDS) {
    const input = addForm.querySelector(`[name="${field.name}"]`)
    const val = input.value.trim()
    if (field.name === 'phone') {
      if (!/^\d{4}$/.test(val)) missing.push(field.label)
    } else {
      if (!val) missing.push(field.label)
    }
  }
  return { valid: missing.length === 0, missing }
}

const formInputs = addForm.querySelectorAll('input[name="pickup_code"], input[name="company"], input[name="recipient"], input[name="phone"], input[name="address"]')

function hasAnyInput() {
  return Array.from(formInputs).some(input => input.value.trim() !== '')
}

function updateButton() {
  if (!hasAnyInput()) {
    submitBtn.textContent = '上传图片'
    submitBtn.disabled = false
    submitBtn.className = 'bg-green-600 hover:bg-green-700 text-white rounded-lg px-4 py-2 transition-colors font-medium w-full sm:w-auto sm:self-start'
    return
  }
  const { valid } = validateForm()
  if (valid) {
    submitBtn.textContent = '添加'
    submitBtn.disabled = false
    submitBtn.className = 'bg-primary hover:bg-blue-700 text-white rounded-lg px-4 py-2 transition-colors font-medium w-full sm:w-auto sm:self-start'
  } else {
    submitBtn.textContent = '添加'
    submitBtn.disabled = true
    submitBtn.className = 'bg-gray-300 text-gray-500 cursor-not-allowed rounded-lg px-4 py-2 transition-colors font-medium w-full sm:w-auto sm:self-start'
  }
}

formInputs.forEach(input => {
  input.addEventListener('input', updateButton)
})

document.querySelectorAll('input[name="recipient"], input[name="phone"], input[name="address"]').forEach(input => {
  input.addEventListener('input', () => {
    if (activeRecognizedIndex !== -1 && recognizedPackages[activeRecognizedIndex]) {
      recognizedPackages[activeRecognizedIndex][input.name] = input.value
    }
  })
})

addForm.querySelector('[name="phone"]').addEventListener('input', function () {
  this.value = this.value.replace(/\D/g, '').slice(0, 4)
})

updateButton()

function renderChips() {
  if (recognizedPackages.length === 0) {
    recognizedEl.classList.add('hidden')
    recognizedEl.innerHTML = ''
    return
  }
  recognizedEl.classList.remove('hidden')
  recognizedEl.innerHTML = recognizedPackages.map((pkg, idx) => `
    <button type="button" class="chip-btn px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${idx === activeRecognizedIndex ? 'bg-primary text-white border-primary' : 'bg-white text-gray-600 border-gray-300 hover:border-primary hover:text-primary'}" data-index="${idx}">
      ${escapeHtml(pkg.pickup_code || `包裹${idx + 1}`)}
    </button>
  `).join('')

  recognizedEl.querySelectorAll('.chip-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index)
      if (activeRecognizedIndex !== -1 && recognizedPackages[activeRecognizedIndex]) {
        recognizedPackages[activeRecognizedIndex].recipient = addForm.querySelector('[name="recipient"]').value
        recognizedPackages[activeRecognizedIndex].phone = addForm.querySelector('[name="phone"]').value
        recognizedPackages[activeRecognizedIndex].address = addForm.querySelector('[name="address"]').value
      }
      activeRecognizedIndex = idx
      fillForm(idx)
      renderChips()
    })
  })
}

function fillForm(index) {
  const pkg = recognizedPackages[index]
  if (!pkg) return
  addForm.querySelector('[name="pickup_code"]').value = pkg.pickup_code || ''
  addForm.querySelector('[name="company"]').value = pkg.company || ''
  addForm.querySelector('[name="recipient"]').value = pkg.recipient || ''
  addForm.querySelector('[name="phone"]').value = pkg.phone || ''
  addForm.querySelector('[name="address"]').value = pkg.address || ''
  formInputs.forEach(input => input.dispatchEvent(new Event('input', { bubbles: true })))
}

submitBtn.addEventListener('click', () => {
  if (!hasAnyInput()) {
    imageInput.click()
    return
  }
  const { valid, missing } = validateForm()
  if (!valid) {
    showToast('未填写的内容：' + missing.join('、'), false)
    return
  }
  addForm.dispatchEvent(new Event('submit'))
})

imageInput.addEventListener('change', async () => {
  const file = imageInput.files[0]
  if (!file) return

  showStatus('正在识别图片中的快递信息...', true, false)

  try {
    const base64 = await compressAndToBase64(file)
    const result = await callSiliconFlow(base64, 'image/jpeg')

    const existingAddresses = await fetchExistingAddresses()

    recognizedPackages = result.map(p => {
      let address = p.address || ''
      if (address) {
        const matched = matchAddress(address, existingAddresses)
        if (matched) address = matched
      }
      return {
        pickup_code: p.pickup_code,
        company: p.company || '',
        recipient: '',
        phone: '',
        address,
      }
    })

    if (recognizedPackages.length > 0) {
      activeRecognizedIndex = 0
      renderChips()
      fillForm(0)
      updateButton()
      showStatus(`识别到 ${recognizedPackages.length} 个包裹，点击可切换查看，继续上传图片可识别更多`, true)
    } else {
      showStatus('未识别到有效的快递信息', false)
    }
  } catch (e) {
    showStatus('识别失败: ' + e.message, false)
  }

  imageInput.value = ''
})

async function fetchExistingAddresses() {
  try {
    const res = await fetch('api/history?field=address')
    if (!res.ok) return []
    const data = await res.json()
    return data.map(item => item.value).filter(v => v)
  } catch {
    return []
  }
}

function similarity(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const char of setA) {
    if (setB.has(char)) intersection++
  }
  return (2 * intersection) / (setA.size + setB.size)
}

function matchAddress(address, existingList) {
  let best = ''
  let bestScore = 0
  for (const existing of existingList) {
    const score = similarity(address, existing)
    if (score > bestScore) {
      bestScore = score
      best = existing
    }
  }
  return bestScore >= 0.7 ? best : null
}

function compressAndToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const MAX = 1200
        let w = img.width
        let h = img.height
        if (w > MAX) {
          h = h * (MAX / w)
          w = MAX
        }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        const base64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1]
        resolve(base64)
      }
      img.onerror = reject
      img.src = reader.result
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function callSiliconFlow(base64Image, mimeType) {
  const response = await authFetch('api/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64Image, mime_type: mimeType }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error('识别请求失败: ' + err)
  }

  const data = await response.json()
  return data.packages
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

let statusTimer = null
function showStatus(msg, ok, autoHide = true) {
  statusBar.textContent = msg
  statusBar.className = `text-center py-3 mb-6 rounded-lg text-sm ${ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`
  statusBar.classList.remove('hidden')
  clearTimeout(statusTimer)
  statusTimer = autoHide ? setTimeout(() => statusBar.classList.add('hidden'), 3000) : null
}

function showToast(msg, ok) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-sm shadow-lg transition-opacity duration-300 ${ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`
  el.classList.remove('hidden')
  el.style.opacity = '1'
  setTimeout(() => {
    el.style.opacity = '0'
    setTimeout(() => el.classList.add('hidden'), 300)
  }, 1500)
}

const STATUS_META = {
  to_ship: { label: '待发货', badge: 'bg-amber-100 text-amber-600' },
  shipping: { label: '运输中', badge: 'bg-blue-100 text-blue-600' },
  pending: { label: '待取件', badge: 'bg-green-100 text-green-600' },
  picked_up: { label: '已取件', badge: 'bg-gray-100 text-gray-500' },
}

function render() {
  let filtered = packages
  if (filterStatus !== 'all') filtered = packages.filter(p => p.status === filterStatus)

  if (filtered.length === 0) {
    listEl.innerHTML = ''
    emptyEl.classList.remove('hidden')
    return
  }
  emptyEl.classList.add('hidden')

  listEl.innerHTML = filtered.map(p => {
    const meta = STATUS_META[p.status] || STATUS_META.pending
    const picked = p.status === 'picked_up'
    const isPending = p.status === 'pending'
    // 待发货/运输中没有取件码，退回展示商品名或状态文案
    const title = p.pickup_code || p.goods_name || meta.label
    const titleCls = !p.pickup_code ? 'text-lg text-gray-600' : (picked ? 'text-gray-400' : 'text-gray-800')
    return `
      <div class="bg-white rounded-xl shadow-sm border border-gray-100 p-4 flex items-center justify-between ${picked ? 'opacity-60' : ''}" data-id="${p.id}">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-3">
            <span class="text-xs ${meta.badge} px-2 py-0.5 rounded-full flex-shrink-0">${meta.label}</span>
            <span class="text-xl font-mono font-bold tracking-widest ${titleCls} truncate">${escapeHtml(title)}</span>
          </div>
          <div class="mt-1 text-sm text-gray-500">
            ${p.company ? escapeHtml(p.company) + ' · ' : ''}${p.recipient ? escapeHtml(p.recipient) : ''}
            ${p.phone ? ` · ${escapeHtml(p.phone)}` : ''}
            ${p.address ? ` · ${escapeHtml(p.address)}` : ''}
            ${p.mail_no ? `<span class="text-xs text-gray-400"> · 运单 ${escapeHtml(p.mail_no)}</span>` : ''}
            <span class="text-xs text-gray-400 ml-2">${p.created_at}</span>
          </div>
        </div>
        <div class="flex gap-2">
          ${isPending ? `<button class="pickup-btn text-sm bg-green-500 text-white px-3 py-1.5 rounded-lg hover:bg-green-600 transition-colors">取件</button>` : ''}
          ${picked ? `<button class="restore-btn text-sm bg-amber-500 text-white px-3 py-1.5 rounded-lg hover:bg-amber-600 transition-colors">未取</button>` : ''}
          <button class="delete-btn text-sm bg-red-500 text-white px-3 py-1.5 rounded-lg hover:bg-red-600 transition-colors">删除</button>
        </div>
      </div>
    `
  }).join('')

  document.querySelectorAll('.pickup-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-id]').dataset.id
      try {
        const res = await authFetch(`api/packages/${id}/pickup`, { method: 'PATCH' })
        if (!res.ok) throw new Error('取件失败')
        showToast('已标记取件', true)
      } catch (e) {
        showToast('操作失败', false)
      }
    })
  })

  document.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-id]').dataset.id
      try {
        const res = await authFetch(`api/packages/${id}/restore`, { method: 'PATCH' })
        if (!res.ok) throw new Error('恢复失败')
        showToast('已恢复为待取件', true)
      } catch (e) {
        showToast('操作失败', false)
      }
    })
  })

let confirmResolve = null

function showConfirm(msg) {
  return new Promise(resolve => {
    document.getElementById('confirmMessage').textContent = msg
    document.getElementById('confirmModal').classList.remove('hidden')
    document.getElementById('confirmModal').classList.add('flex')
    confirmResolve = resolve
  })
}

document.getElementById('confirmOk').addEventListener('click', () => {
  document.getElementById('confirmModal').classList.add('hidden')
  document.getElementById('confirmModal').classList.remove('flex')
  if (confirmResolve) confirmResolve(true)
})

document.getElementById('confirmCancel').addEventListener('click', () => {
  document.getElementById('confirmModal').classList.add('hidden')
  document.getElementById('confirmModal').classList.remove('flex')
  if (confirmResolve) confirmResolve(false)
})

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const confirmed = await showConfirm('确定删除？')
      if (!confirmed) return
      const id = btn.closest('[data-id]').dataset.id
      try {
        const res = await authFetch(`api/packages/${id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('删除失败')
        showToast('已删除', true)
      } catch (e) {
        showToast('操作失败', false)
      }
    })
  })
}

const FILTER_BTNS = {
  all: filterAll,
  to_ship: filterToShip,
  shipping: filterShipping,
  pending: filterPending,
  picked_up: filterPicked,
}

function setFilter(status) {
  filterStatus = status
  Object.values(FILTER_BTNS).forEach(el => {
    el.classList.remove('bg-primary', 'text-white', 'border-primary')
    el.classList.add('bg-white', 'text-gray-600', 'border-gray-300')
  })
  const active = FILTER_BTNS[status] || filterAll
  active.classList.remove('bg-white', 'text-gray-600', 'border-gray-300')
  active.classList.add('bg-primary', 'text-white', 'border-primary')
  render()
}

filterAll.addEventListener('click', () => setFilter('all'))
filterToShip.addEventListener('click', () => setFilter('to_ship'))
filterShipping.addEventListener('click', () => setFilter('shipping'))
filterPending.addEventListener('click', () => setFilter('pending'))
filterPicked.addEventListener('click', () => setFilter('picked_up'))

const openAddBtn = document.getElementById('openAddBtn')
const addModal = document.getElementById('addModal')
const addCloseBtn = document.getElementById('addCloseBtn')

function openAddModal() {
  addModal.classList.remove('hidden')
  addModal.classList.add('flex')
}

function closeAddModal() {
  addModal.classList.add('hidden')
  addModal.classList.remove('flex')
}

openAddBtn.addEventListener('click', openAddModal)
addCloseBtn.addEventListener('click', closeAddModal)
addModal.addEventListener('click', e => {
  if (e.target === addModal) closeAddModal()
})

const refreshBtn = document.getElementById('refreshBtn')

async function refreshPackages() {
  if (refreshBtn.disabled) return
  refreshBtn.disabled = true
  refreshBtn.classList.add('opacity-50', 'cursor-not-allowed')
  refreshBtn.querySelector('svg').classList.add('animate-spin')
  showStatus('正在刷新快递状态并拉取新快递，请稍候...', true, false)
  try {
    const [taobaoStatus, pddStatus] = await Promise.all([
      authFetch('api/express/status').then(r => r.json()).catch(() => null),
      authFetch('api/pdd/status').then(r => r.json()).catch(() => null),
    ])
    if (!taobaoStatus && !pddStatus) {
      showStatus('无法获取账号配置状态，请刷新页面后重试', false)
      return
    }

    const taobaoOn = !!(taobaoStatus && taobaoStatus.cookie_set)
    const pddOn = !!(pddStatus && pddStatus.cookie_set)
    if (!taobaoOn && !pddOn) {
      showStatus('尚未配置淘宝 / 拼多多账号，请先在右上角账号管理中完成配置', false)
      return
    }

    const parts = []
    const skipped = []
    let hadError = false

    if (taobaoOn) {
      try {
        const syncRes = await authFetch('api/express/sync', { method: 'POST' })
        const syncData = await syncRes.json()
        if (!syncRes.ok) throw new Error(syncData.error || '拉取新快递失败')
        const fillRes = await authFetch('api/express/fill-codes', { method: 'POST' })
        const fillData = await fillRes.json()
        if (!fillRes.ok) throw new Error(fillData.error || '刷新取件码失败')
        parts.push(`淘宝新增 ${syncData.created.length} 件、刷新取件码 ${fillData.filled.length} 件`)
      } catch (e) {
        hadError = true
        parts.push(`淘宝刷新失败：${e.message}`)
      }
    } else {
      skipped.push('淘宝')
    }

    if (pddOn) {
      try {
        const pddRes = await authFetch('api/pdd/sync', { method: 'POST' })
        const pddData = await pddRes.json()
        if (!pddRes.ok) throw new Error(pddData.error || '拼多多同步失败')
        parts.push(`拼多多新增 ${pddData.created.length} 件`)
      } catch (e) {
        hadError = true
        parts.push(`拼多多同步失败：${e.message}`)
      }
    } else {
      skipped.push('拼多多')
    }

    loadAll()
    const tail = skipped.length ? `（未配置${skipped.join('、')}，已跳过）` : ''
    showStatus(parts.join('；') + tail, !hadError)
  } catch (e) {
    showStatus('刷新失败：' + e.message, false)
  } finally {
    refreshBtn.disabled = false
    refreshBtn.classList.remove('opacity-50', 'cursor-not-allowed')
    refreshBtn.querySelector('svg').classList.remove('animate-spin')
  }
}

refreshBtn.addEventListener('click', refreshPackages)

addForm.addEventListener('submit', async e => {
  e.preventDefault()
  const fd = new FormData(addForm)
  const body = Object.fromEntries(fd)
  if (!body.company) body.company = ''

  const duplicate = packages.some(p =>
    p.pickup_code === body.pickup_code && p.address === body.address
  )
  if (duplicate) {
    showToast('已录入', false)
    return
  }

  try {
    const res = await authFetch('api/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || '添加失败')
    }
    addForm.reset()

    if (activeRecognizedIndex !== -1 && recognizedPackages[activeRecognizedIndex]) {
      recognizedPackages.splice(activeRecognizedIndex, 1)
      if (recognizedPackages.length > 0) {
        activeRecognizedIndex = 0
        renderChips()
        fillForm(0)
      } else {
        activeRecognizedIndex = -1
        renderChips()
      }
      updateButton()
    }

    showToast('添加成功', true)
  } catch (e) {
    showToast(e.message, false)
  }
})

async function loadAll() {
  if (window._adminController) window._adminController.abort()
  window._adminController = new AbortController()
  try {
    const res = await fetch('api/packages?status=all', { signal: window._adminController.signal })
    packages = await res.json()
    render()
  } catch (e) {
    if (e.name !== 'AbortError') showToast('加载数据失败', false)
  }
}

const evtSource = new EventSource('api/events')
evtSource.addEventListener('create', e => {
  packages.unshift(JSON.parse(e.data))
  render()
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
evtSource.onerror = () => showToast('实时连接断开，正在重连...', false)

/* ───── 自动同步（淘宝系） ───── */

const syncBadge = document.getElementById('syncBadge')
const pddBadge = document.getElementById('pddBadge')
const saveCookieBtn = document.getElementById('saveCookieBtn')
const taobaoCookieEl = document.getElementById('taobaoCookie')
const scanLoginBtn = document.getElementById('scanLoginBtn')
const qrPanel = document.getElementById('qrPanel')
const qrImg = document.getElementById('qrImg')
const qrStatus = document.getElementById('qrStatus')
const qrRefreshBtn = document.getElementById('qrRefreshBtn')

function setBadge(el, configured) {
  el.textContent = configured ? 'Cookie 已配置' : '未配置'
  el.className = configured
    ? 'text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-600'
    : 'text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500'
}

async function loadExpressStatus() {
  try {
    const res = await authFetch('api/express/status')
    if (res.ok) setBadge(syncBadge, (await res.json()).cookie_set)
  } catch (e) {}
  try {
    const res = await authFetch('api/pdd/status')
    if (res.ok) setBadge(pddBadge, (await res.json()).cookie_set)
  } catch (e) {}
}

saveCookieBtn.addEventListener('click', async () => {
  const cookie = taobaoCookieEl.value.trim()
  if (!cookie) return showToast('请先粘贴 Cookie', false)
  saveCookieBtn.disabled = true
  try {
    const res = await authFetch('api/express/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '保存失败')
    taobaoCookieEl.value = ''
    showToast('Cookie 已保存', true)
    loadExpressStatus()
  } catch (e) {
    showToast(e.message, false)
  } finally {
    saveCookieBtn.disabled = false
  }
})

const taobaoDeleteBtn = document.getElementById('taobaoDeleteBtn')
taobaoDeleteBtn.addEventListener('click', async () => {
  if (!await showConfirm('确定删除淘宝账号？将清除已保存的 Cookie。')) return
  try {
    const res = await authFetch('api/express/cookie', { method: 'DELETE' })
    if (!res.ok) throw new Error('删除失败')
    showToast('已删除淘宝账号', true)
    showAccountView('list')
  } catch (e) {
    showToast(e.message, false)
  }
})

let qrTimer = null
let qrSessionId = null

function stopQrPolling() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
  qrSessionId = null
}

function setQrStatus(text, cls) {
  qrStatus.textContent = text
  qrStatus.className = cls || 'text-gray-600'
}

async function startScanLogin() {
  stopQrPolling()
  scanLoginBtn.disabled = true
  scanLoginBtn.textContent = '获取二维码中...'
  qrRefreshBtn.classList.add('hidden')
  qrPanel.classList.remove('hidden')
  try {
    const res = await authFetch('api/express/qrcode', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '获取二维码失败')
    qrSessionId = data.session_id
    qrImg.src = data.qr
    setQrStatus('请用手机淘宝「扫一扫」')
    qrTimer = setInterval(pollQr, 2000)
  } catch (e) {
    qrImg.removeAttribute('src')
    setQrStatus(e.message, 'text-red-500')
    qrRefreshBtn.classList.remove('hidden')
  } finally {
    scanLoginBtn.disabled = false
    scanLoginBtn.textContent = '扫码登录淘宝'
  }
}

async function pollQr() {
  if (!qrSessionId) return
  try {
    const res = await authFetch('api/express/qrcode/' + qrSessionId)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '轮询失败')

    if (data.status === 'SCANED') {
      setQrStatus('已扫码，请在手机上确认登录', 'text-amber-600')
      return
    }
    if (data.status === 'CONFIRMED') {
      stopQrPolling()
      setQrStatus('登录成功', 'text-green-600')
      showToast('淘宝登录成功', true)
      setTimeout(() => qrPanel.classList.add('hidden'), 1200)
      loadExpressStatus()
      return
    }
    if (data.status === 'EXPIRED' || data.status === 'CANCELED') {
      stopQrPolling()
      setQrStatus(data.status === 'EXPIRED' ? '二维码已过期' : '已取消登录', 'text-gray-500')
      qrRefreshBtn.classList.remove('hidden')
    }
  } catch (e) {
    stopQrPolling()
    setQrStatus(e.message, 'text-red-500')
    qrRefreshBtn.classList.remove('hidden')
  }
}

scanLoginBtn.addEventListener('click', startScanLogin)
qrRefreshBtn.addEventListener('click', startScanLogin)

const accountBtn = document.getElementById('accountBtn')
const accountModal = document.getElementById('accountModal')
const accountCloseBtn = document.getElementById('accountCloseBtn')
const accountListView = document.getElementById('accountListView')
const platformPickerView = document.getElementById('platformPickerView')
const taobaoAddView = document.getElementById('taobaoAddView')
const pddAddView = document.getElementById('pddAddView')
const addAccountBtn = document.getElementById('addAccountBtn')
const taobaoConfigBtn = document.getElementById('taobaoConfigBtn')
const pddConfigBtn = document.getElementById('pddConfigBtn')

const accountViews = {
  list: accountListView,
  picker: platformPickerView,
  taobao: taobaoAddView,
  pdd: pddAddView,
}

function showAccountView(name) {
  for (const key in accountViews) {
    accountViews[key].classList.toggle('hidden', key !== name)
  }
  if (name !== 'taobao') stopQrPolling()
  if (name === 'list') loadExpressStatus()
}

function openAccountModal() {
  accountModal.classList.remove('hidden')
  accountModal.classList.add('flex')
  showAccountView('list')
}

function closeAccountModal() {
  stopQrPolling()
  accountModal.classList.add('hidden')
  accountModal.classList.remove('flex')
}

accountBtn.addEventListener('click', openAccountModal)
accountCloseBtn.addEventListener('click', closeAccountModal)
accountModal.addEventListener('click', e => {
  if (e.target === accountModal) closeAccountModal()
})

addAccountBtn.addEventListener('click', () => showAccountView('picker'))
taobaoConfigBtn.addEventListener('click', () => showAccountView('taobao'))
pddConfigBtn.addEventListener('click', () => showAccountView('pdd'))

document.querySelectorAll('.view-back-btn').forEach(btn => {
  btn.addEventListener('click', () => showAccountView(btn.dataset.back))
})

document.querySelectorAll('.platform-option').forEach(btn => {
  btn.addEventListener('click', () => showAccountView(btn.dataset.platform))
})

loadExpressStatus()

loadAll()

addEventListener('beforeunload', () => {
  if (window._adminController) window._adminController.abort()
  evtSource.close()
})

/* ───── 拼多多（独立渠道） ───── */

const pddCookieEl = document.getElementById('pddCookie')
const savePddCookieBtn = document.getElementById('savePddCookieBtn')

savePddCookieBtn.addEventListener('click', async () => {
  const cookie = pddCookieEl.value.trim()
  if (!cookie) return showToast('请先粘贴 Cookie', false)
  savePddCookieBtn.disabled = true
  try {
    const res = await authFetch('api/pdd/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '保存失败')
    pddCookieEl.value = ''
    showToast('拼多多 Cookie 已保存', true)
  } catch (e) {
    showToast(e.message, false)
  } finally {
    savePddCookieBtn.disabled = false
  }
})

const pddDeleteBtn = document.getElementById('pddDeleteBtn')
pddDeleteBtn.addEventListener('click', async () => {
  if (!await showConfirm('确定删除拼多多账号？将清除已保存的 Cookie。')) return
  try {
    const res = await authFetch('api/pdd/cookie', { method: 'DELETE' })
    if (!res.ok) throw new Error('删除失败')
    showToast('已删除拼多多账号', true)
    showAccountView('list')
  } catch (e) {
    showToast(e.message, false)
  }
})
