/* ───────────── 基础工具 ───────────── */

const $ = id => document.getElementById(id)

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str == null ? '' : String(str)
  return div.innerHTML
}

/**
 * 属性值转义。escapeHtml 基于 textContent/innerHTML，不会转义双引号，
 * 直接塞进 title="..." 会被商品名里的引号撑断属性，因此单独处理。
 */
function escapeAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 取件码每 4 位数字插一个空格，便于核对。
 * 只切分「连续数字段」：9-1-4408 这类带横杠的码长度不足 4 位，原样保留。
 * 与展示页 app.js 的同名函数保持一致；仅用于显示，存储与录入框一律是原始值。
 */
function formatCode(code) {
  if (!code) return ''
  return String(code).replace(/\d{4}(?=\d)/g, m => m + ' ')
}

/** 显示/隐藏面板。hide 时用内联 display:none 强制生效，避免被 lg:/hidden 等类覆盖 */
function togglePanel(el, show, display) {
  if (show) {
    el.classList.remove('hidden')
    el.style.display = display || ''
  } else {
    el.classList.add('hidden')
    el.style.display = 'none'
  }
}

/** 仅切换 hidden 类：用于带 lg: 响应式显示的容器（PC 常显、移动端可切换） */
function setHidden(el, hidden) {
  el.classList.toggle('hidden', hidden)
}

let toastTimer = null
function showToast(msg, ok) {
  const el = $('toast')
  el.textContent = msg
  el.className = `fixed top-4 left-1/2 -translate-x-1/2 z-[70] px-4 py-2 rounded-lg text-sm shadow-lg transition-opacity duration-300 ${ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`
  el.style.opacity = '1'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.style.opacity = '0'
    setTimeout(() => el.classList.add('hidden'), 300)
  }, 1500)
}

let statusTimer = null
function showStatus(msg, ok, autoHide = true) {
  const el = $('statusBar')
  el.textContent = msg
  el.className = `text-center py-3 mb-6 rounded-lg text-sm ${ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`
  clearTimeout(statusTimer)
  statusTimer = autoHide ? setTimeout(() => el.classList.add('hidden'), 3000) : null
}

/* ───────────── 鉴权 ───────────── */

function getSession() {
  try {
    var s = JSON.parse(localStorage.getItem('admin_session') || '{}')
    if (s.pw && s.expiresAt > Date.now()) return s.pw
  } catch (e) {}
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

/* ───────────── 输入自动补全（收件人 / 尾号 / 地址） ───────────── */

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

/* ───────────── 录入 / 编辑表单 ───────────── */

const addForm = $('addForm')
const addModal = $('addModal')
const submitBtn = $('submitBtn')
const uploadBtn = $('uploadBtn')
const uploadEntry = $('uploadEntry')
const imageInput = $('imageInput')
const recognizedEl = $('recognizedPackages')
const recognizedWrap = $('recognizedWrap')
const editMeta = $('editMeta')
const editMetaText = $('editMetaText')
const addActions = $('addActions')
const editActions = $('editActions')

const REQUIRED_FIELDS = [
  { name: 'pickup_code', label: '取件码' },
  { name: 'recipient', label: '收件人' },
  { name: 'phone', label: '手机尾号' },
  { name: 'address', label: '取件地址' },
]

let recognizedPackages = []
let activeRecognizedIndex = -1
/** null 表示新增，否则为正在编辑的包裹 id */
let editingId = null

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

function updateSubmitState() {
  const { valid } = validateForm()
  submitBtn.disabled = !valid
  submitBtn.className = `h-12 lg:h-11 w-full lg:w-auto px-5 rounded-xl text-sm font-medium transition-colors ${valid ? 'bg-primary text-white hover:bg-blue-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`
}

formInputs.forEach(input => {
  input.addEventListener('input', updateSubmitState)
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

function renderChips() {
  if (recognizedPackages.length === 0) {
    togglePanel(recognizedWrap, false)
    recognizedEl.innerHTML = ''
    return
  }
  togglePanel(recognizedWrap, true)
  recognizedEl.innerHTML = recognizedPackages.map((pkg, idx) => `
    <button type="button" class="chip-btn h-9 px-3.5 rounded-xl text-sm font-medium border transition-colors ${idx === activeRecognizedIndex ? 'bg-primary text-white border-primary code-font' : 'bg-white text-gray-600 border-gray-300 hover:border-primary hover:text-primary code-font'}" data-index="${idx}">
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

function openAddModal() {
  editingId = null
  $('addModalTitle').textContent = '添加快递'
  addForm.reset()
  togglePanel(editMeta, false)
  togglePanel(uploadEntry, true)
  togglePanel(addActions, true)
  togglePanel(editActions, false)
  renderChips()
  updateSubmitState()
  addModal.classList.remove('hidden')
  addModal.classList.add('flex')
}

function openEditModal(p) {
  editingId = p.id
  $('addModalTitle').textContent = '编辑快递'
  addForm.querySelector('[name="pickup_code"]').value = p.pickup_code || ''
  addForm.querySelector('[name="company"]').value = p.company || ''
  addForm.querySelector('[name="recipient"]').value = p.recipient || ''
  addForm.querySelector('[name="phone"]').value = p.phone || ''
  addForm.querySelector('[name="address"]').value = p.address || ''
  formInputs.forEach(input => input.dispatchEvent(new Event('input', { bubbles: true })))

  editMetaText.textContent = `录入于 ${p.created_at || '—'}${p.company ? ' · ' + p.company : ''}`
  togglePanel(editMeta, true, 'flex')
  togglePanel(uploadEntry, false)
  togglePanel(addActions, false)
  togglePanel(editActions, true, 'flex')

  addModal.classList.remove('hidden')
  addModal.classList.add('flex')
}

function closeAddModal() {
  editingId = null
  addModal.classList.add('hidden')
  addModal.classList.remove('flex')
}

document.querySelectorAll('.js-add').forEach(btn => btn.addEventListener('click', openAddModal))
$('addCloseBtn').addEventListener('click', closeAddModal)
addModal.addEventListener('click', e => {
  if (e.target === addModal) closeAddModal()
})

submitBtn.addEventListener('click', () => {
  const { valid, missing } = validateForm()
  if (!valid) {
    showToast('未填写的内容：' + missing.join('、'), false)
    return
  }
  addForm.dispatchEvent(new Event('submit'))
})

uploadBtn.addEventListener('click', () => imageInput.click())
uploadEntry.addEventListener('click', () => imageInput.click())

/* ───────────── 图片识别（上传截图） ───────────── */

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
      updateSubmitState()
      showStatus(`识别到 ${recognizedPackages.length} 个包裹，点击可切换查看，继续上传截图可识别更多`, true)
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

/* ───────────── 确认框 ───────────── */

const confirmModal = $('confirmModal')
let confirmResolve = null

function showConfirm(msg) {
  return new Promise(resolve => {
    $('confirmMessage').textContent = msg
    confirmModal.classList.remove('hidden')
    confirmModal.classList.add('flex')
    confirmResolve = resolve
  })
}

function closeConfirm(value) {
  confirmModal.classList.add('hidden')
  confirmModal.classList.remove('flex')
  if (confirmResolve) confirmResolve(value)
  confirmResolve = null
}

$('confirmOk').addEventListener('click', () => closeConfirm(true))
$('confirmCancel').addEventListener('click', () => closeConfirm(false))

/* ───────────── 列表渲染 ───────────── */

const STATUS_META = {
  to_ship: { label: '待发货', badge: 'bg-amber-50 text-amber-600' },
  shipping: { label: '运输中', badge: 'bg-blue-50 text-blue-600' },
  pending: { label: '待取件', badge: 'bg-emerald-50 text-emerald-600' },
  picked_up: { label: '已取件', badge: 'bg-gray-100 text-gray-500' },
}

const STATUS_FILTER_BASE = 'status-filter-btn flex-shrink-0 h-8 lg:h-9 px-3.5 lg:px-4 rounded-full text-[13px] lg:text-sm font-medium border transition-colors'
const FILTER_ON = 'bg-primary text-white border-primary'
const FILTER_OFF = 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'

let filterStatus = 'all'
let packages = []

const PC_GRID = 'grid grid-cols-[88px_minmax(0,1.4fr)_minmax(0,1fr)_80px_minmax(0,1.2fr)_minmax(0,1fr)_140px_168px] gap-4'

function actionButtons(p) {
  const isPending = p.status === 'pending'
  const picked = p.status === 'picked_up'
  return `
    ${isPending ? '<button class="js-pickup h-8 px-3 rounded-lg bg-primary text-white text-xs font-medium hover:bg-blue-700 transition-colors">取件</button>' : ''}
    ${picked ? '<button class="js-restore h-8 px-3 rounded-lg bg-white border border-gray-300 text-xs font-medium text-gray-600 hover:border-gray-400 transition-colors">未取</button>' : ''}
    <button class="js-edit h-8 w-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-primary hover:bg-blue-50 transition-colors" title="编辑" aria-label="编辑"><svg class="ico w-4 h-4"><use href="#i-edit"/></svg></button>
    <button class="js-del h-8 w-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="删除" aria-label="删除"><svg class="ico w-4 h-4"><use href="#i-trash"/></svg></button>
  `
}

/** PC 行：容器内分隔行 + 表头列对齐 */
function renderPcRow(p) {
  const meta = STATUS_META[p.status] || STATUS_META.pending
  const picked = p.status === 'picked_up'
  const hasCode = !!p.pickup_code
  // 只有取件码分组显示；商品名不是码，原样展示
  const title = hasCode ? formatCode(p.pickup_code) : (p.goods_name || meta.label)
  const titleCls = hasCode
    ? (picked ? 'code-font text-lg font-bold tracking-wider text-gray-300 line-through decoration-gray-300' : 'code-font text-lg font-bold tracking-wider text-gray-900')
    : 'text-base font-medium text-gray-700'

  return `
    <div class="${PC_GRID} px-5 py-3.5 border-b border-gray-100 items-center transition-colors ${picked ? 'bg-gray-50/50 hover:bg-gray-50' : 'hover:bg-gray-50/60'}" data-id="${p.id}">
      <span class="inline-flex w-fit text-xs px-2.5 py-1 rounded-full ${meta.badge} font-medium">${meta.label}</span>
      <span class="${titleCls} line-clamp-2" title="${escapeAttr(title)}">${escapeHtml(title)}</span>
      <span class="text-sm truncate ${picked ? 'text-gray-400' : 'text-gray-600'}">${escapeHtml(p.recipient || '—')}</span>
      <span class="text-sm code-font ${picked ? 'text-gray-300' : 'text-gray-400'}">${escapeHtml(p.phone || '—')}</span>
      <span class="text-sm line-clamp-2 ${picked ? 'text-gray-400' : 'text-gray-500'}" title="${escapeAttr(p.address || '—')}">${escapeHtml(p.address || '—')}</span>
      <span class="text-xs code-font truncate ${picked ? 'text-gray-300' : 'text-gray-400'}" title="${escapeAttr(p.mail_no || '—')}">${escapeHtml(p.mail_no || '—')}</span>
      <span class="text-xs text-gray-400 code-font">${escapeHtml(p.updated_at || p.created_at || '')}</span>
      <span class="flex justify-end gap-1">${actionButtons(p)}</span>
    </div>
  `
}

/** 移动端卡片：主操作提到与取件码同行，编辑/删除收进左滑 */
function renderMbCard(p) {
  const meta = STATUS_META[p.status] || STATUS_META.pending
  const picked = p.status === 'picked_up'
  const hasCode = !!p.pickup_code
  const title = hasCode ? formatCode(p.pickup_code) : (p.goods_name || meta.label)
  const titleCls = hasCode
    ? (picked ? 'code-font text-2xl font-bold tracking-wider text-gray-300 line-through decoration-gray-300' : 'code-font text-2xl font-bold tracking-wider text-gray-900')
    : 'text-base font-medium text-gray-700 truncate'

  // 高度从 44px 收到 36px：卡片本身有 16px 内边距，加上按钮四周留白，
  // 实际可点区域仍有约 68×44，触控不吃亏；投影只给主操作，描边次要按钮加投影会显脏
  const mainAction = p.status === 'pending'
    ? '<button class="js-pickup flex-shrink-0 h-9 px-4 rounded-xl bg-primary text-white text-[13px] font-medium shadow-md shadow-primary/30">取件</button>'
    : (picked ? '<button class="js-restore flex-shrink-0 h-9 px-3.5 rounded-xl bg-white border border-gray-300 text-[13px] font-medium text-gray-600 flex items-center gap-1.5"><svg class="ico w-3.5 h-3.5"><use href="#i-undo"/></svg>未取</button>' : '')

  const source = [p.company, p.recipient, p.phone ? '尾号 ' + p.phone : ''].filter(Boolean).join(' · ') || '—'

  return `
    <div class="swipe-item relative overflow-hidden border-b border-gray-100 last:border-b-0" data-id="${p.id}">
      <div class="absolute inset-y-0 right-0 flex">
        <button class="js-edit w-[76px] bg-amber-500 flex flex-col items-center justify-center gap-1" aria-label="编辑">
          <svg class="ico w-5 h-5 text-white"><use href="#i-edit"/></svg>
          <span class="text-[11px] font-medium text-white">编辑</span>
        </button>
        <button class="js-del w-[76px] bg-red-500 flex flex-col items-center justify-center gap-1" aria-label="删除">
          <svg class="ico w-5 h-5 text-white"><use href="#i-trash"/></svg>
          <span class="text-[11px] font-medium text-white">删除</span>
        </button>
      </div>
      <!-- 收紧内边距与行距换高度：字号和按钮尺寸不动，保住可读性与触控面积 -->
      <div class="swipe-card relative ${picked ? 'bg-gray-50' : 'bg-white'} p-3">
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <span class="text-xs px-2.5 py-0.5 rounded-full ${meta.badge} font-medium">${meta.label}</span>
          <span class="text-[11px] text-gray-400 code-font flex-shrink-0">${escapeHtml(p.updated_at || p.created_at || '')}</span>
        </div>
        <div class="flex items-center gap-3">
          <p class="flex-1 min-w-0 truncate ${titleCls}">${escapeHtml(title)}</p>
          ${mainAction}
        </div>
        <p class="mt-1.5 text-[13px] truncate flex items-center gap-1.5 ${picked ? 'text-gray-400' : 'text-gray-500'}">
          <svg class="ico w-3.5 h-3.5 flex-shrink-0"><use href="#i-pin"/></svg>${escapeHtml(p.address || '未知取件点')}
        </p>
        <p class="text-[13px] text-gray-400 truncate">${escapeHtml(source)}</p>
      </div>
    </div>
  `
}

function render() {
  // 待发货不展示（无取件码，且已不作为筛选维度）
  const visible = packages.filter(p => p.status !== 'to_ship')

  const counts = { all: visible.length, shipping: 0, pending: 0, picked_up: 0 }
  for (const p of visible) {
    if (counts[p.status] !== undefined) counts[p.status]++
  }
  document.querySelectorAll('[data-count]').forEach(el => {
    el.textContent = counts[el.dataset.count] || 0
  })
  $('summaryCount').textContent = visible.length

  document.querySelectorAll('.status-filter-btn').forEach(btn => {
    const on = btn.dataset.status === filterStatus
    btn.className = `${STATUS_FILTER_BASE} ${on ? FILTER_ON : FILTER_OFF}`
    // 计数徽标跟随按钮选中态调整对比度
    const badge = btn.querySelector('[data-count]')
    if (badge) badge.className = `${on ? 'opacity-70' : 'text-gray-400'} code-font`
  })

  const filtered = filterStatus === 'all' ? visible : visible.filter(p => p.status === filterStatus)

  // 两个列表各自靠 lg:hidden / hidden lg:block 控制断点显隐，
  // 这里只用内联 display 做「有数据/无数据」的总开关，不能动 hidden 类
  if (filtered.length === 0) {
    $('listPcBody').innerHTML = ''
    $('listMb').innerHTML = ''
    $('listPc').style.display = 'none'
    $('listMb').style.display = 'none'
    $('swipeHint').classList.add('hidden')
    $('swipeHint').classList.remove('flex')
    togglePanel($('empty'), true, 'flex')
    return
  }
  togglePanel($('empty'), false)
  $('listPc').style.display = ''
  $('listMb').style.display = ''
  $('listPcBody').innerHTML = filtered.map(renderPcRow).join('')
  $('listMb').innerHTML = filtered.map(renderMbCard).join('')

  showSwipeHintIfNeeded()

  bindRowActions()
  bindSwipe()
}

function findPackage(el) {
  const id = el.closest('[data-id]').dataset.id
  return packages.find(x => String(x.id) === String(id))
}

function bindRowActions() {
  document.querySelectorAll('.js-pickup').forEach(btn => {
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

  document.querySelectorAll('.js-restore').forEach(btn => {
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

  document.querySelectorAll('.js-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = findPackage(btn)
      if (p) openEditModal(p)
    })
  })

  document.querySelectorAll('.js-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const p = findPackage(btn)
      if (!p) return
      const confirmed = await showConfirm(`确定删除取件码 ${p.pickup_code || p.goods_name || ''}？`)
      if (!confirmed) return
      try {
        const res = await authFetch(`api/packages/${p.id}`, { method: 'DELETE' })
        if (!res.ok) throw new Error('删除失败')
        showToast('已删除', true)
      } catch (e) {
        showToast('操作失败', false)
      }
    })
  })
}

/* ───────────── 移动端左滑露出操作 ───────────── */

const SWIPE_REVEAL = 152
let openSwipeItem = null

function setSwipe(item, open) {
  const card = item.querySelector('.swipe-card')
  card.style.transform = open ? `translateX(-${SWIPE_REVEAL}px)` : ''
  item.classList.toggle('swipe-open', open)
  if (open) {
    if (openSwipeItem && openSwipeItem !== item) setSwipe(openSwipeItem, false)
    openSwipeItem = item
  } else if (openSwipeItem === item) {
    openSwipeItem = null
  }
}

/** 左滑提示：只在移动端、且用户没滑动过时显示一次 */
const SWIPE_HINT_KEY = 'pickup_swipe_hint_seen'

function showSwipeHintIfNeeded() {
  const el = $('swipeHint')
  let seen = false
  try { seen = localStorage.getItem(SWIPE_HINT_KEY) === '1' } catch (e) {}
  const show = !seen && !window.matchMedia('(min-width: 1024px)').matches
  el.classList.toggle('hidden', !show)
  el.classList.toggle('flex', show)
}

function dismissSwipeHint() {
  const el = $('swipeHint')
  el.classList.add('hidden')
  el.classList.remove('flex')
  try { localStorage.setItem(SWIPE_HINT_KEY, '1') } catch (e) {}
}

$('swipeHintClose').addEventListener('click', dismissSwipeHint)

function bindSwipe() {
  openSwipeItem = null
  document.querySelectorAll('.swipe-item').forEach(item => {
    const card = item.querySelector('.swipe-card')
    let startX = 0, startY = 0, baseX = 0, dragging = false, decided = false

    card.addEventListener('touchstart', e => {
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      baseX = item.classList.contains('swipe-open') ? -SWIPE_REVEAL : 0
      dragging = true
      decided = false
      card.style.transition = 'none'
    }, { passive: true })

    card.addEventListener('touchmove', e => {
      if (!dragging) return
      const t = e.touches[0]
      const mx = t.clientX - startX
      const my = t.clientY - startY
      if (!decided) {
        if (Math.abs(mx) < 6 && Math.abs(my) < 6) return
        decided = true
        // 纵向滑动优先交给页面滚动，避免误触侧滑
        if (Math.abs(my) > Math.abs(mx)) {
          dragging = false
          card.style.transition = ''
          return
        }
        e.preventDefault()
        dismissSwipeHint()
      }
      const next = Math.min(0, Math.max(-SWIPE_REVEAL, baseX + mx))
      card.style.transform = `translateX(${next}px)`
    }, { passive: false })

    card.addEventListener('touchend', () => {
      if (!dragging) return
      dragging = false
      card.style.transition = ''
      const m = /translateX\((-?[\d.]+)px\)/.exec(card.style.transform)
      const cur = m ? parseFloat(m[1]) : 0
      setSwipe(item, cur < -SWIPE_REVEAL / 2)
    })

    card.addEventListener('touchcancel', () => {
      dragging = false
      card.style.transition = ''
      setSwipe(item, item.classList.contains('swipe-open'))
    })
  })
}

/* 点击/滚动时收起已展开的侧滑 */
document.addEventListener('touchstart', e => {
  if (openSwipeItem && !openSwipeItem.contains(e.target)) setSwipe(openSwipeItem, false)
}, { passive: true })
window.addEventListener('scroll', () => {
  if (openSwipeItem) setSwipe(openSwipeItem, false)
}, { passive: true })

/* ───────────── 新增 / 编辑提交 ───────────── */

addForm.addEventListener('submit', async e => {
  e.preventDefault()
  const fd = new FormData(addForm)
  const body = Object.fromEntries(fd)
  if (!body.company) body.company = ''

  const duplicate = packages.some(p =>
    String(p.id) !== String(editingId) &&
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
    }
    updateSubmitState()
    showToast('添加成功', true)
  } catch (e) {
    showToast(e.message, false)
  }
})

$('editSaveBtn').addEventListener('click', async () => {
  const { valid, missing } = validateForm()
  if (!valid) {
    showToast('未填写的内容：' + missing.join('、'), false)
    return
  }
  const body = {}
  formInputs.forEach(input => { body[input.name] = input.value.trim() })
  try {
    const res = await authFetch(`api/packages/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '保存失败')
    closeAddModal()
    showToast('已保存', true)
  } catch (e) {
    showToast(e.message, false)
  }
})

$('editDeleteBtn').addEventListener('click', async () => {
  const p = packages.find(x => String(x.id) === String(editingId))
  if (!p) return
  const confirmed = await showConfirm(`确定删除取件码 ${p.pickup_code || p.goods_name || ''}？`)
  if (!confirmed) return
  try {
    const res = await authFetch(`api/packages/${p.id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('删除失败')
    closeAddModal()
    showToast('已删除', true)
  } catch (e) {
    showToast(e.message, false)
  }
})

document.querySelectorAll('.status-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    filterStatus = btn.dataset.status
    render()
  })
})

/* ───────────── 更新快递 ───────────── */

const refreshBtns = document.querySelectorAll('.js-refresh')

function setRefreshing(on) {
  refreshBtns.forEach(btn => {
    btn.disabled = on
    btn.classList.toggle('opacity-50', on)
    btn.classList.toggle('cursor-not-allowed', on)
    const svg = btn.querySelector('svg')
    if (svg) svg.classList.toggle('animate-spin', on)
  })
}

async function refreshPackages() {
  if (refreshBtns[0] && refreshBtns[0].disabled) return
  setRefreshing(true)
  showStatus('正在刷新快递状态并拉取新快递，请稍候...', true, false)
  try {
    // 各渠道相互独立：未配置账号的渠道静默跳过，不能因为某个渠道没账号而中断整轮刷新
    const [taobaoData, pddData] = await Promise.all([
      authFetch('api/express/accounts').then(r => r.json()),
      authFetch('api/pdd/accounts').then(r => r.json()),
    ])
    const hasTaobao = !!(taobaoData && taobaoData.accounts && taobaoData.accounts.length)
    const hasPdd = !!(pddData && pddData.accounts && pddData.accounts.length)
    if (!hasTaobao && !hasPdd) throw new Error('请先添加账号')

    let taobaoCreated = 0
    let filled = 0
    if (hasTaobao) {
      const syncRes = await authFetch('api/express/sync', { method: 'POST' })
      const syncData = await syncRes.json()
      if (!syncRes.ok) throw new Error(syncData.error || '拉取新快递失败')

      const fillRes = await authFetch('api/express/fill-codes', { method: 'POST' })
      const fillData = await fillRes.json()
      if (!fillRes.ok) throw new Error(fillData.error || '刷新快递状态失败')

      taobaoCreated = syncData.created.length
      filled = fillData.filled.length
    }

    // 拼多多渠道：拉取新快递；失败不影响淘宝刷新
    let pddCreated = 0
    if (hasPdd) {
      try {
        const pddRes = await authFetch('api/pdd/sync', { method: 'POST' })
        if (pddRes.ok) pddCreated = (await pddRes.json()).created.length
      } catch (e) { /* 忽略拼多多异常 */ }
    }

    loadAll()
    showStatus(`已拉取新快递 ${taobaoCreated} 件，刷新取件码 ${filled} 件，拼多多新增 ${pddCreated} 件`, true)
  } catch (e) {
    showStatus('刷新失败：' + e.message, false)
  } finally {
    setRefreshing(false)
  }
}

refreshBtns.forEach(btn => btn.addEventListener('click', refreshPackages))

/* ───────────── 数据加载与实时同步 ───────────── */

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
  const idx = packages.findIndex(x => String(x.id) === String(p.id))
  if (idx !== -1) packages[idx] = p
  else packages.unshift(p)
  render()
})
evtSource.addEventListener('delete', e => {
  const p = JSON.parse(e.data)
  packages = packages.filter(x => String(x.id) !== String(p.id))
  render()
})
evtSource.onerror = () => showToast('实时连接断开，正在重连...', false)

/* ───────────── 账号管理 ───────────── */

const PLATFORMS = {
  taobao: {
    name: '淘宝',
    initial: '淘',
    iconCls: 'bg-orange-50 text-orange-500',
    hasScan: true,
    accountsUrl: 'api/express/accounts',
    qrcodeUrl: 'api/express/qrcode',
    hint: '浏览器登录 taobao.com 后按 F12 → Network → 任意请求 → 复制 Cookie',
    site: 'taobao.com',
    siteUrl: 'https://www.taobao.com',
    cookiePlaceholder: '_m_h5_tk=...; _m_h5_tk_enc=...; cookie2=...; unb=...',
  },
  pdd: {
    name: '拼多多',
    initial: '拼',
    iconCls: 'bg-red-50 text-red-500',
    hasScan: false,
    accountsUrl: 'api/pdd/accounts',
    hint: '将浏览器 UA 切换为 iPad 后登录 mobile.yangkeduo.com，按 F12 → Network → 任意请求 → 复制 Cookie',
    site: 'mobile.yangkeduo.com',
    siteUrl: 'https://mobile.yangkeduo.com',
    cookiePlaceholder: 'PDDAccessToken=...; pdd_user_id=...; pdd_user_uin=...',
  },
}

/** 各平台的账号列表；lastSync 为该平台最近一次同步记录 */
const platformAccounts = { taobao: [], pdd: [] }
const platformLastSync = { taobao: null, pdd: null }

let activePlatform = 'taobao'
let currentAuthTab = 'scan'
let editingAccountId = null  // null = 新增模式
let cookieUpdateMode = false // 编辑已有账号时重设 Cookie

const accountModal = $('accountModal')
const settingsPane = $('settingsPane')

/** 单个账号状态：依据该账号最近一次同步结果 */
function accountState(a) {
  if (a.last_sync_status === 'error') return { label: '登录失效', cls: 'bg-red-50 text-red-600' }
  if (a.last_sync_status === 'ok') return { label: '正常', cls: 'bg-emerald-50 text-emerald-600' }
  return { label: '未同步', cls: 'bg-gray-100 text-gray-500' }
}

/** 平台账号状态：汇总该平台下所有账号 */
function platformState(list) {
  if (list.length === 0) return { label: '未配置', cls: 'bg-gray-100 text-gray-500', dot: 'bg-gray-300' }
  if (list.some(a => a.last_sync_status === 'error')) return { label: '登录失效', cls: 'bg-red-50 text-red-600', dot: 'bg-red-400' }
  if (list.every(a => a.last_sync_status === 'ok')) return { label: '正常', cls: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-400' }
  return { label: '未同步', cls: 'bg-gray-100 text-gray-500', dot: 'bg-amber-400' }
}

/** 2026-10-27 10:35:45 → 10-27 10:35 */
function formatStamp(s) {
  return String(s || '').slice(5, 16)
}

function renderPlatformList() {
  $('accountPlatformList').innerHTML = Object.entries(PLATFORMS).map(([key, pf]) => {
    const list = platformAccounts[key]
    const on = activePlatform === key
    const st = platformState(list)
    return `
      <button data-platform="${key}" class="platform-item w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${on ? 'border-primary/30 bg-white card-shadow' : 'border-transparent hover:bg-white/80'}">
        <span class="w-9 h-9 rounded-lg ${pf.iconCls} flex items-center justify-center text-sm font-semibold flex-shrink-0">${pf.initial}</span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm font-medium ${on ? '' : 'text-gray-700'}">${pf.name}</span>
          <span class="block text-[11px] text-gray-400 mt-0.5">${list.length > 0 ? list.length + ' 个账号' : '未添加账号'}</span>
        </span>
        <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 ${st.dot}" title="${st.label}"></span>
      </button>
    `
  }).join('')

  document.querySelectorAll('.platform-item').forEach(btn => {
    btn.addEventListener('click', () => openPlatform(btn.dataset.platform))
  })

  // 移动端：平台分段切换（替代原来的平台列表页）
  $('accountPlatformTabs').innerHTML = Object.entries(PLATFORMS).map(([key, pf]) => {
    const on = activePlatform === key
    return `<button data-platform="${key}" class="platform-tab flex-1 h-9 rounded-lg text-sm font-medium transition-colors ${on ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}">${pf.name}</button>`
  }).join('')
  document.querySelectorAll('.platform-tab').forEach(btn => {
    btn.addEventListener('click', () => openPlatform(btn.dataset.platform))
  })
}

/** 详情页顶部「N 个账号」徽标 */
function updateDetailBadge() {
  const n = platformAccounts[activePlatform].length
  const el = $('accountDetailBadge')
  el.textContent = `${n} 个账号`
  el.className = `text-xs px-2 py-0.5 rounded-full font-medium ${n > 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'}`
}

/** 平台最近一次同步时间（仅淘宝有） */
function renderLastSync() {
  const last = platformLastSync[activePlatform]
  $('accountLastSync').innerHTML = last
    ? `<svg class="ico w-3.5 h-3.5"><use href="#i-clock"/></svg>最近同步 ${escapeHtml(last.created_at || '')}`
    : ''
}

/** 渲染当前平台的账号列表 */
function renderAccountRows() {
  const list = platformAccounts[activePlatform]
  const pf = PLATFORMS[activePlatform]

  if (list.length === 0) {
    $('accountRows').innerHTML = `
      <div class="text-center py-10">
        <span class="w-12 h-12 rounded-2xl bg-gray-100 text-gray-400 flex items-center justify-center mx-auto"><svg class="ico w-5 h-5"><use href="#i-plus"/></svg></span>
        <p class="text-sm text-gray-500 mt-3">还没有添加${escapeHtml(pf.name)}账号</p>
        <p class="text-xs text-gray-400 mt-1">添加后会同步在途与待取件包裹</p>
        <button class="js-empty-add mt-4 h-10 px-4 rounded-xl bg-primary text-white text-sm font-medium inline-flex items-center gap-1.5">
          <svg class="ico w-4 h-4"><use href="#i-plus"/></svg>添加账号
        </button>
      </div>`
    const addBtn = document.querySelector('.js-empty-add')
    if (addBtn) addBtn.addEventListener('click', () => openAccountEditor(null))
    return
  }

  $('accountRows').innerHTML = list.map(a => {
    const st = accountState(a)
    const invalid = a.last_sync_status === 'error'

    const timeText = a.last_sync_at ? `最近同步 ${formatStamp(a.last_sync_at)}` : `添加于 ${formatStamp(a.created_at)}`
    const pieces = []
    if (a.shipping) pieces.push(`运输中 ${a.shipping}`)
    if (a.pending) pieces.push(`待取件 ${a.pending}`)
    const countText = pieces.join(' · ')

    const avatarCls = invalid
      ? 'bg-white border border-red-100 text-red-500'
      : (a.last_sync_status === 'ok' ? pf.iconCls : 'bg-gray-100 text-gray-400')
    const metaCls = invalid ? 'text-red-500/80' : 'text-gray-400'

    return `
      <div data-id="${a.id}" class="account-row w-full flex items-center gap-3.5 p-4 rounded-xl border text-left transition-colors cursor-pointer ${invalid ? 'border-red-200 bg-red-50/40' : 'border-gray-200 bg-white hover:border-primary/40'}">
        <span class="w-10 h-10 rounded-xl ${avatarCls} text-sm font-semibold flex items-center justify-center flex-shrink-0">${pf.initial}</span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium truncate">${escapeHtml(a.remark || '未命名账号')}</span>
            <span class="text-[11px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${invalid ? 'bg-white text-red-600' : st.cls}">${st.label}</span>
          </div>
          <div class="mt-1.5 flex items-center gap-1.5 text-xs ${metaCls}">
            <svg class="ico w-3.5 h-3.5 flex-shrink-0"><use href="#i-clock"/></svg>
            <span class="truncate">${escapeHtml(timeText)}</span>
          </div>
          ${countText ? `<div class="mt-1 flex items-center gap-1.5 text-xs ${metaCls}">
            <svg class="ico w-3.5 h-3.5 flex-shrink-0"><use href="#i-box"/></svg>
            <span class="truncate">${escapeHtml(countText)}</span>
          </div>` : ''}
        </div>
        ${invalid
          ? `<button class="js-update-account h-9 px-3.5 rounded-xl bg-white border border-red-200 text-red-600 text-sm font-medium flex items-center gap-1.5 flex-shrink-0"><svg class="ico w-4 h-4"><use href="#i-link"/></svg>更新账户</button>`
          : `<svg class="ico w-4 h-4 text-gray-300 flex-shrink-0"><use href="#i-arrow-right"/></svg>`}
      </div>
    `
  }).join('')

  document.querySelectorAll('.account-row').forEach(el => {
    el.addEventListener('click', () => openAccountEditor(Number(el.dataset.id)))
  })
  document.querySelectorAll('.js-update-account').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      openAccountEditor(Number(btn.closest('.account-row').dataset.id), true)
    })
  })
}

/** 标题：桌面显示平台名，移动端显示「账号管理」 */
function setDetailTitle(desktop, mobile) {
  $('accountDetailTitle').textContent = desktop
  $('accountMobileTitle').textContent = mobile || desktop
}

/** 切回账号列表视图 */
function showListPane() {
  togglePanel($('accountListPane'), true)
  togglePanel($('accountEditorPane'), false)
  togglePanel(settingsPane, false)
  togglePanel($('accountDeleteWrap'), false)
  togglePanel($('accountPlatformTabs'), true)
  setSettingsEntryActive(false)
  setDetailTitle(PLATFORMS[activePlatform].name, '账号管理')
  setHidden($('accountDetailBadge'), false)
  setHidden($('accountBackBtn'), true)
  renderAccountRows()
  renderLastSync()
  updateDetailBadge()
}

function openPlatform(key) {
  // 先提交上一个平台的备注改动
  if (key !== activePlatform) flushRemark()
  activePlatform = key
  editingAccountId = null
  renderPlatformList()
  showListPane()
}

/** 复制文本到剪贴板（非安全上下文下回退到 execCommand） */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) {
    return false
  }
}

// 提示里的平台网址：点击复制
$('cookieHint').addEventListener('click', async e => {
  const btn = e.target.closest('.cookie-site')
  if (!btn) return
  const url = btn.dataset.url
  const ok = await copyText(url)
  showToast(ok ? `已复制 ${url}` : `复制失败，请手动复制：${url}`, ok)
})

/** 「更新快递」按钮：账号登录失效时文案变为「更新账户」 */
function refreshAccountAction() {
  if (!editingAccountId) return
  const acc = platformAccounts[activePlatform].find(a => a.id === editingAccountId)
  const invalid = !!acc && acc.last_sync_status === 'error'
  $('accountSyncLabel').textContent = invalid ? '更新账户' : '更新快递'
}

/** 同步当前编辑的账号 */
async function runAccountSync() {
  if (!editingAccountId) return
  const pf = PLATFORMS[activePlatform]
  const btn = $('accountSyncBtn')
  btn.disabled = true
  btn.classList.add('opacity-50')
  try {
    const res = await authFetch(`${pf.accountsUrl}/${editingAccountId}/sync`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '更新快递失败')
    showToast(`${pf.name}：${data.summary}`, true)
    loadAll()
  } catch (e) {
    showToast(e.message, false)
  } finally {
    btn.disabled = false
    btn.classList.remove('opacity-50')
    // 同步结果会改变账号状态（成功/失效），loadAccounts 内会同步按钮文案
    await loadAccounts()
    const acc = editingAccountId ? platformAccounts[activePlatform].find(a => a.id === editingAccountId) : null
    renderAuthStatus(acc || null)
  }
}

/** 登录状态卡片：正常 / 失效 / 未同步 */
function renderAuthStatus(acc) {
  const el = $('authStatusCard')
  if (!acc) {
    el.innerHTML = ''
    togglePanel(el, false)
    return
  }
  const invalid = acc.last_sync_status === 'error'
  const ok = acc.last_sync_status === 'ok'
  const view = invalid
    ? {
        box: 'bg-red-50 border-red-100',
        icon: 'text-red-500', iconName: 'i-alert',
        title: 'text-red-700', titleText: 'Cookie 已失效',
        desc: 'text-red-700/70', descText: '重新粘贴 Cookie 后会自动校验登录态并同步一次。',
      }
    : ok
      ? {
          box: 'bg-emerald-50/60 border-emerald-100',
          icon: 'text-emerald-600', iconName: 'i-check',
          title: 'text-emerald-700', titleText: '登录态正常',
          desc: 'text-emerald-700/70',
          descText: `上次校验 ${acc.last_sync_at ? formatStamp(acc.last_sync_at) : '—'}，可直接更新快递。`,
        }
      : {
          box: 'bg-gray-50 border-gray-200',
          icon: 'text-gray-400', iconName: 'i-clock',
          title: 'text-gray-600', titleText: '尚未同步',
          desc: 'text-gray-400', descText: '点击底部「更新快递」验证登录态并拉取一次包裹。',
        }

  el.innerHTML = `
    <div class="flex items-start gap-3 rounded-xl border p-3.5 ${view.box}">
      <span class="w-8 h-8 rounded-lg bg-white flex items-center justify-center flex-shrink-0 ${view.icon}"><svg class="ico w-4 h-4"><use href="#${view.iconName}"/></svg></span>
      <div class="min-w-0">
        <p class="text-sm font-medium ${view.title}">${view.titleText}</p>
        <p class="text-xs ${view.desc} mt-1 leading-relaxed">${view.descText}</p>
      </div>
    </div>`
  togglePanel(el, true)
}

/** 打开账号编辑：id 为空表示新增；expandCookie 用于失效账号直接展开 Cookie 重设 */
function openAccountEditor(id, expandCookie) {
  const pf = PLATFORMS[activePlatform]
  const acc = id ? platformAccounts[activePlatform].find(a => a.id === id) : null
  editingAccountId = acc ? acc.id : null
  const isNew = !acc

  $('accountEditorTitle').textContent = isNew ? '添加账号' : (acc.remark || '未命名账号')
  setDetailTitle(PLATFORMS[activePlatform].name, isNew ? '添加账号' : (acc.remark || '未命名账号'))
  $('remarkInput').value = acc ? (acc.remark || '') : ''
  $('remarkInput').dataset.saved = acc ? (acc.remark || '') : ''

  // 已有账号：展示添加时间与最近同步
  togglePanel($('accountMeta'), !isNew)
  if (!isNew) {
    $('accountCreatedAt').textContent = acc.created_at || '—'
    $('accountLastSyncAt').textContent = acc.last_sync_at || '—'
    $('accountLastSyncAt').className = `code-font ${acc.last_sync_status === 'error' ? 'text-red-600' : 'text-gray-700'}`
  }

  // 提示里的平台网址做成可点击复制
  const siteHtml = `<button type="button" class="cookie-site text-primary font-medium hover:underline" data-url="${pf.siteUrl}" title="点击复制网址">${escapeHtml(pf.site)}</button>`
  $('cookieHint').innerHTML = escapeHtml(pf.hint).replace(pf.site, siteHtml)
  $('cookieInput').placeholder = pf.cookiePlaceholder
  $('cookieInput').value = ''

  // 已有账号：底部为「更新快递」+「删除账户」；登录失效时前者变为「更新账户」并可展开 Cookie 重设
  cookieUpdateMode = !!expandCookie
  $('saveCookieBtn').textContent = cookieUpdateMode ? '更新' : '保存'
  togglePanel($('accountDeleteWrap'), !isNew, 'flex')
  renderAuthStatus(isNew ? null : acc)

  if (isNew) {
    currentAuthTab = pf.hasScan ? 'scan' : 'cookie'
    togglePanel($('authTabs'), pf.hasScan, 'grid')
    renderAuthPanels()
  } else {
    togglePanel($('authTabs'), false)
    togglePanel($('scanPanel'), false)
    togglePanel($('cookiePanel'), cookieUpdateMode)
    stopQrPolling()
    refreshAccountAction()
  }

  togglePanel($('accountPlatformTabs'), false)
  togglePanel($('accountListPane'), false)
  togglePanel($('accountEditorPane'), true)
  togglePanel(settingsPane, false)
  // 编辑视图内已有返回按钮，隐藏 header 的返回，避免出现两个
  setHidden($('accountBackBtn'), true)
  updateDetailBadge()
}

/** 移动端返回账号列表 */
function showAccountList() {
  flushRemark()
  editingAccountId = null
  showListPane()
  if (!window.matchMedia('(min-width: 1024px)').matches) stopQrPolling()
}

function renderAuthPanels() {
  const pf = PLATFORMS[activePlatform]
  const isScan = pf.hasScan && currentAuthTab === 'scan'

  togglePanel($('scanPanel'), isScan, 'flex')
  togglePanel($('cookiePanel'), !isScan)

  document.querySelectorAll('.auth-tab').forEach(btn => {
    const on = btn.dataset.panel === currentAuthTab
    btn.className = `auth-tab h-10 rounded-lg text-sm font-medium transition-colors ${on ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`
  })

  if (isScan) {
    if (!qrSessionId) startScanLogin()
  } else {
    stopQrPolling()
  }
}

document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    currentAuthTab = btn.dataset.panel
    renderAuthPanels()
  })
})

async function loadAccounts() {
  for (const key of Object.keys(PLATFORMS)) {
    try {
      const res = await authFetch(PLATFORMS[key].accountsUrl)
      if (res.ok) {
        const d = await res.json()
        platformAccounts[key] = d.accounts || []
        platformLastSync[key] = d.last_sync || null
      }
    } catch (e) {}
  }
  renderPlatformList()
  updateDetailBadge()
  if ($('accountEditorPane').classList.contains('hidden')) {
    renderAccountRows()
    renderLastSync()
  } else {
    refreshAccountAction()
  }
}

async function openAccountModal() {
  accountModal.classList.remove('hidden')
  accountModal.classList.add('flex')
  await Promise.all([loadAccounts(), loadSettings()])
  openPlatform(activePlatform)
}

function closeAccountModal() {
  flushRemark()
  stopQrPolling()
  accountModal.classList.add('hidden')
  accountModal.classList.remove('flex')
}

document.querySelectorAll('.js-account').forEach(btn => btn.addEventListener('click', openAccountModal))
$('accountBackBtn').addEventListener('click', showAccountList)
$('accountSettingsBtn').addEventListener('click', openSettings)
document.querySelectorAll('.account-close').forEach(btn => btn.addEventListener('click', closeAccountModal))
accountModal.addEventListener('click', e => {
  if (e.target === accountModal) closeAccountModal()
})
$('addAccountBtn').addEventListener('click', () => openAccountEditor(null))
$('accountEditorBack').addEventListener('click', () => {
  flushRemark()
  editingAccountId = null
  stopQrPolling()
  showListPane()
})

/* ───── 设置：代取快递显示 / 关键词 / 版本号 ───── */

const settingsEntry = $('settingsEntry')

function setSettingsEntryActive(on) {
  settingsEntry.className = `w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl lg:rounded-xl border text-left transition-colors ${on ? 'border-primary/40 bg-white card-shadow text-primary' : 'border-gray-200 bg-white hover:border-gray-300 text-gray-600'}`
}

const proxyKeywordTags = $('proxyKeywordTags')
const proxyKeywordInput = $('proxyKeywordInput')
let proxyKeywordList = []

function renderProxyKeywordTags() {
  proxyKeywordTags.querySelectorAll('.kw-tag').forEach(el => el.remove())
  for (const kw of proxyKeywordList) {
    const chip = document.createElement('span')
    chip.className = 'kw-tag inline-flex items-center gap-1 h-7 pl-2.5 pr-1.5 rounded-lg bg-gray-100 text-xs text-gray-700'
    chip.innerHTML = `<span>${escapeHtml(kw)}</span><button type="button" class="w-4 h-4 rounded flex items-center justify-center text-gray-400 hover:bg-gray-200 hover:text-gray-600 transition-colors" aria-label="删除标签"><svg class="ico w-3 h-3"><use href="#i-x"/></svg></button>`
    chip.querySelector('button').addEventListener('click', () => {
      proxyKeywordList = proxyKeywordList.filter(x => x !== kw)
      renderProxyKeywordTags()
    })
    proxyKeywordInput.before(chip)
  }
}

/** 回车添加；支持一次输入/粘贴多个（逗号分隔），自动去重 */
function addProxyKeyword(raw) {
  const parts = String(raw || '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
  for (const p of parts) {
    if (!proxyKeywordList.includes(p)) proxyKeywordList.push(p)
  }
  if (parts.length) renderProxyKeywordTags()
}

proxyKeywordInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  addProxyKeyword(proxyKeywordInput.value)
  proxyKeywordInput.value = ''
})

/* 自动更新频率：自定义下拉，避免原生 select 的系统面板与页面风格割裂 */

const SYNC_OPTIONS = [
  [30, '每 30 分钟'],
  [60, '每 1 小时'],
  [180, '每 3 小时'],
  [360, '每 6 小时'],
  [720, '每 12 小时'],
  [1440, '每 24 小时'],
]
let syncIntervalValue = 60

const syncIntervalBtn = $('syncIntervalBtn')
const syncIntervalMenu = $('syncIntervalMenu')

function renderSyncIntervalMenu() {
  syncIntervalMenu.innerHTML = SYNC_OPTIONS.map(([value, label]) => {
    const on = value === syncIntervalValue
    return `
      <button type="button" data-value="${value}" role="option" aria-selected="${on}"
        class="w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-sm text-left transition-colors ${on ? 'text-primary bg-primary/5 font-medium' : 'text-gray-600 hover:bg-gray-50'}">
        <span>${label}</span>
        ${on ? '<svg class="ico w-4 h-4 flex-shrink-0"><use href="#i-check"/></svg>' : ''}
      </button>
    `
  }).join('')

  syncIntervalMenu.querySelectorAll('[data-value]').forEach(btn => {
    btn.addEventListener('click', () => {
      setSyncInterval(Number(btn.dataset.value))
      closeSyncIntervalMenu()
    })
  })
}

function setSyncInterval(value) {
  const hit = SYNC_OPTIONS.find(([v]) => v === Number(value)) || SYNC_OPTIONS[1]
  syncIntervalValue = hit[0]
  $('syncIntervalLabel').textContent = hit[1]
  renderSyncIntervalMenu()
}

function openSyncIntervalMenu() {
  renderSyncIntervalMenu()
  syncIntervalMenu.classList.remove('hidden')
  syncIntervalBtn.setAttribute('aria-expanded', 'true')
  $('syncIntervalArrow').classList.add('rotate-180')
}

function closeSyncIntervalMenu() {
  syncIntervalMenu.classList.add('hidden')
  syncIntervalBtn.setAttribute('aria-expanded', 'false')
  $('syncIntervalArrow').classList.remove('rotate-180')
}

syncIntervalBtn.addEventListener('click', () => {
  if (syncIntervalMenu.classList.contains('hidden')) openSyncIntervalMenu()
  else closeSyncIntervalMenu()
})

// 点击空白处收起
document.addEventListener('click', e => {
  if (!syncIntervalBtn.contains(e.target) && !syncIntervalMenu.contains(e.target)) closeSyncIntervalMenu()
})

async function loadSettings() {
  try {
    const res = await authFetch('api/settings')
    if (!res.ok) return
    const s = await res.json()
    $('versionText').textContent = s.version ? `v${s.version}` : ''
    $('showProxyToggle').checked = !!s.show_proxy
    setSyncInterval(s.sync_interval || 60)
    proxyKeywordList = (s.proxy_keywords || '').split(/[,，]/).map(x => x.trim()).filter(Boolean)
    renderProxyKeywordTags()
  } catch (e) {}
}

async function openSettings() {
  flushRemark()
  editingAccountId = null
  stopQrPolling()
  setSettingsEntryActive(true)
  setDetailTitle('设置', '设置')
  setHidden($('accountDetailBadge'), true)
  setHidden($('accountBackBtn'), false)
  togglePanel($('accountPlatformTabs'), false)
  togglePanel($('accountListPane'), false)
  togglePanel($('accountEditorPane'), false)
  togglePanel($('accountDeleteWrap'), false)
  togglePanel(settingsPane, true)
  await loadSettings()
}

settingsEntry.addEventListener('click', openSettings)

$('settingsSaveBtn').addEventListener('click', async () => {
  const btn = $('settingsSaveBtn')
  // 输入框里还没回车的文字也一并保存，避免遗漏
  addProxyKeyword(proxyKeywordInput.value)
  proxyKeywordInput.value = ''
  btn.disabled = true
  try {
    const res = await authFetch('api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        show_proxy: $('showProxyToggle').checked,
        proxy_keywords: proxyKeywordList.join(','),
        sync_interval: syncIntervalValue,
      }),
    })
    if (!res.ok) throw new Error('保存失败')
    showToast('设置已保存', true)
    loadAll() // 立刻按新设置重新过滤列表
  } catch (e) {
    showToast(e.message, false)
  } finally {
    btn.disabled = false
  }
})

/**
 * 提交当前账号备注（值未变则跳过）。
 * 失焦、切平台、关闭弹窗三处都会调用 —— 只依赖 blur 的话，
 * 用户直接切平台或关弹窗时改动会静默丢失。仅编辑已有账号时有效。
 */
async function flushRemark() {
  if (!editingAccountId) return
  const input = $('remarkInput')
  const remark = input.value.trim()
  if (remark === (input.dataset.saved || '')) return
  const platform = activePlatform
  const id = editingAccountId
  try {
    const res = await authFetch(`${PLATFORMS[platform].accountsUrl}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remark }),
    })
    if (!res.ok) throw new Error('备注保存失败')
    input.dataset.saved = remark
    const acc = platformAccounts[platform].find(a => a.id === id)
    if (acc) acc.remark = remark
    renderPlatformList()
    showToast('备注已保存', true)
  } catch (e) {
    showToast(e.message, false)
  }
}

$('remarkInput').addEventListener('blur', flushRemark)

/** 新增账号：粘贴 Cookie 后保存；已有账号失效重设 Cookie 时走 PATCH */
$('saveCookieBtn').addEventListener('click', async () => {
  const pf = PLATFORMS[activePlatform]
  const cookie = $('cookieInput').value.trim()
  if (!cookie) return showToast('请先粘贴 Cookie', false)
  const remark = $('remarkInput').value.trim()
  const btn = $('saveCookieBtn')
  const isUpdate = !!editingAccountId && cookieUpdateMode
  btn.disabled = true
  try {
    if (isUpdate) {
      const res = await authFetch(`${pf.accountsUrl}/${editingAccountId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '更新失败')
      $('cookieInput').value = ''
      cookieUpdateMode = false
      $('saveCookieBtn').textContent = '保存'
      togglePanel($('cookiePanel'), false)
      showToast('Cookie 已更新，正在校验登录态...', true)
      await loadAccounts()
      await runAccountSync()
      return
    }

    const res = await authFetch(pf.accountsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, remark }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '保存失败')
    $('cookieInput').value = ''
    showToast(`${pf.name}账号已添加`, true)
    editingAccountId = null
    await loadAccounts()
    showListPane()
  } catch (e) {
    showToast(e.message, false)
  } finally {
    btn.disabled = false
  }
})

/** 底部主按钮：正常账号 → 同步该账号；登录失效 → 展开 Cookie 重设 */
$('accountSyncBtn').addEventListener('click', () => {
  if (!editingAccountId) return
  const acc = platformAccounts[activePlatform].find(a => a.id === editingAccountId)
  if (acc && acc.last_sync_status === 'error') {
    cookieUpdateMode = true
    $('cookieInput').value = ''
    $('saveCookieBtn').textContent = '更新'
    togglePanel($('cookiePanel'), true)
    $('cookieInput').focus()
    return
  }
  runAccountSync()
})

$('accountDeleteBtn').addEventListener('click', async () => {
  const pf = PLATFORMS[activePlatform]
  if (!editingAccountId) return
  if (!await showConfirm(`确定删除该${pf.name}账号？`)) return
  try {
    const res = await authFetch(`${pf.accountsUrl}/${editingAccountId}`, { method: 'DELETE' })
    if (!res.ok) throw new Error('删除失败')
    showToast('已删除账号', true)
    editingAccountId = null
    await loadAccounts()
    showListPane()
  } catch (e) {
    showToast(e.message, false)
  }
})

/* ───────────── 扫码登录 ───────────── */

const qrImg = $('qrImg')
const qrOverlay = $('qrOverlay')
const qrDot = $('qrDot')
const qrStatusEl = $('qrStatus')
const scanLoginBtn = $('scanLoginBtn')
const qrRefreshBtn = $('qrRefreshBtn')

let qrTimer = null
let qrSessionId = null

const QR_DOT = { waiting: 'bg-gray-300', scanned: 'bg-amber-500', success: 'bg-emerald-500', expired: 'bg-gray-400', error: 'bg-red-400' }
const QR_TEXT = { waiting: 'text-gray-600', scanned: 'text-amber-600', success: 'text-emerald-600', expired: 'text-gray-500', error: 'text-red-500' }

function setQrState(state, text) {
  qrDot.className = `w-1.5 h-1.5 rounded-full flex-shrink-0 ${QR_DOT[state] || QR_DOT.waiting}`
  qrStatusEl.textContent = text
  qrStatusEl.className = `text-sm ${QR_TEXT[state] || QR_TEXT.waiting}`
}

function showQrOverlay(show) {
  togglePanel(qrOverlay, show, 'flex')
}

function stopQrPolling() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null }
  qrSessionId = null
}

async function startScanLogin() {
  stopQrPolling()
  showQrOverlay(false)
  setQrState('waiting', '正在获取二维码...')
  try {
    const res = await authFetch('api/express/qrcode', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '获取二维码失败')
    qrSessionId = data.session_id
    qrImg.src = data.qr
    setQrState('waiting', '请用手机淘宝「扫一扫」')
    qrTimer = setInterval(pollQr, 2000)
  } catch (e) {
    qrImg.removeAttribute('src')
    setQrState('error', e.message)
    showQrOverlay(true)
  }
}

async function pollQr() {
  if (!qrSessionId) return
  try {
    const res = await authFetch('api/express/qrcode/' + qrSessionId)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '轮询失败')

    if (data.status === 'SCANED') {
      setQrState('scanned', '已扫码，请在手机上确认登录')
      return
    }
    if (data.status === 'CONFIRMED') {
      stopQrPolling()
      setQrState('success', '登录成功')
      showToast('淘宝账号已添加', true)
      // 扫码成功后服务端已新增一个账号：回到账号列表并刷新
      editingAccountId = null
      await loadAccounts()
      showListPane()
      return
    }
    if (data.status === 'EXPIRED' || data.status === 'CANCELED') {
      stopQrPolling()
      setQrState('expired', data.status === 'EXPIRED' ? '二维码已过期' : '已取消登录')
      showQrOverlay(true)
    }
  } catch (e) {
    stopQrPolling()
    setQrState('error', e.message)
    showQrOverlay(true)
  }
}

scanLoginBtn.addEventListener('click', startScanLogin)
qrRefreshBtn.addEventListener('click', startScanLogin)
$('qrCancelBtn').addEventListener('click', () => {
  stopQrPolling()
  qrImg.removeAttribute('src')
  setQrState('waiting', '已取消，点击刷新二维码重新获取')
  showQrOverlay(true)
})

/* ───────────── 初始化 ───────────── */

showQrOverlay(true)
renderPlatformList()
loadAccounts()

updateSubmitState()

loadAll()

addEventListener('beforeunload', () => {
  if (window._adminController) window._adminController.abort()
  evtSource.close()
})
