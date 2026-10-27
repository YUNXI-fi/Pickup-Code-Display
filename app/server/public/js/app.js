const listPcEl = document.getElementById('listPc')
const listMbEl = document.getElementById('listMb')
const emptyEl = document.getElementById('empty')
const statusBar = document.getElementById('statusBar')

const groupAddressBtn = document.getElementById('groupAddress')
const groupStatusBtn = document.getElementById('groupStatus')
const filterAllBtn = document.getElementById('filterAll')
const filterPendingBtn = document.getElementById('filterPending')
const filterPickedBtn = document.getElementById('filterPicked')

const filterPendingMbBtn = document.getElementById('filterPendingMb')
const filterPickedMbBtn = document.getElementById('filterPickedMb')
const groupMenuBtn = document.getElementById('groupMenuBtn')
const groupSheet = document.getElementById('groupSheet')
const undoToast = document.getElementById('undoToast')
const undoBtn = document.getElementById('undoBtn')

let packages = []
let groupBy = 'address'
// 移动端没有「全部」，默认看待取；桌面默认全部
let filterStatus = window.matchMedia('(min-width: 1024px)').matches ? 'all' : 'pending'

/* 色条只用于分组标题，标识「哪个驿站」；卡片本身不再带颜色，避免同一个色条
   在「按地址」视图表示分组、在「按情况」视图表示状态，两种语义互相干扰。 */
const GROUP_COLORS = [
  'bg-emerald-500', 'bg-blue-500', 'bg-amber-500',
  'bg-violet-500', 'bg-rose-500', 'bg-cyan-500',
]

/* 分段/胶囊按钮的样式常量：切换时整体重设 className，避免残留状态类 */
const FILTER_BASE = 'filter-btn flex-shrink-0 h-8 px-3.5 rounded-full text-[13px] font-medium border transition-colors lg:h-9 lg:px-4 lg:rounded-[10px] lg:text-sm'
const FILTER_ACTIVE = 'bg-primary text-white border-primary'
const FILTER_INACTIVE = 'bg-white text-gray-600 border-gray-200 hover:border-gray-300 lg:bg-transparent lg:border-transparent lg:text-gray-500 lg:hover:text-gray-800'

const GROUP_BASE = 'group-btn flex-1 lg:flex-none h-9 px-4 rounded-[10px] text-[13px] lg:text-sm font-medium transition-colors'
const GROUP_ACTIVE = 'bg-primary text-white'
const GROUP_INACTIVE = 'text-gray-500 hover:text-gray-800'

function timeAgo(t) {
  const diff = Date.now() - new Date(t).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return `${h} 小时前`
}

/** 2026-10-27 10:35:45 → 10-27 10:35 */
function fmtStamp(t) {
  return String(t || '').slice(5, 16)
}

/** 本地当前时间，格式与后端 datetime('now','localtime') 一致 */
function nowStamp() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function isToday(dateStr) {
  if (!dateStr) return false
  return dateStr.startsWith(new Date().toISOString().slice(0, 10))
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str == null ? '' : String(str)
  return div.innerHTML
}

/**
 * 取件码每 4 位数字插一个空格，便于对着屏幕在柜机上输码。
 * 只切分「连续数字段」：9-1-4408 这类带横杠的码长度不足 4 位，原样保留；
 * 末尾不足 4 位的余数也不补空格（靠前瞻断言保证）。
 */
function formatCode(code) {
  if (!code) return ''
  // 用函数式替换而非 '$& '：字符串替换里的 $ 序列容易被误当反向引用，显式拼更稳
  return String(code).replace(/\d{4}(?=\d)/g, m => m + ' ')
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
    const da = (a.pickup_code || '').match(/\d/)
    const db = (b.pickup_code || '').match(/\d/)
    if (da && db) return da[0].localeCompare(db[0])
    if (da) return -1
    if (db) return 1
    return (a.pickup_code || '').localeCompare(b.pickup_code || '', 'zh-CN')
  })
}

function recipientLine(p) {
  const name = p.recipient ? maskRecipient(p.recipient) : '未知收件人'
  const phone = p.phone ? maskPhone(p.phone) : ''
  return `
    <span class="truncate">${escapeHtml(name)}</span>
    ${phone ? `<span class="text-gray-300">·</span><span class="flex-shrink-0">尾号 ${escapeHtml(phone)}</span>` : ''}
  `
}

const PICKED_BADGE_MB = '<span class="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full text-xs font-medium bg-white border border-gray-200 text-gray-500"><svg class="ico w-3.5 h-3.5"><use href="#i-check"/></svg>已取件</span>'
const PICKED_BADGE_PC = '<span class="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 px-2.5 py-1.5 rounded-full"><svg class="ico w-3.5 h-3.5"><use href="#i-check"/></svg>已取件</span>'
const PICKUP_BTN_MB = '<button class="pickup-btn h-11 px-5 rounded-xl bg-primary text-white text-sm font-medium hover:bg-blue-700 transition-colors">取件</button>'
const PICKUP_BTN_PC = '<button class="pickup-btn h-10 px-5 rounded-xl bg-primary text-white text-sm font-medium hover:bg-blue-700 transition-colors">取件</button>'

function renderItem(p) {
  const picked = p.status === 'picked_up'
  const cardCls = picked
    ? 'bg-gray-50 rounded-2xl border border-gray-200/70 p-4 lg:p-5'
    : 'bg-white rounded-2xl border border-gray-200/80 card-shadow p-4 lg:p-5 hover:shadow-md transition-shadow'
  const codeCls = picked
    ? 'text-gray-300 line-through decoration-gray-300'
    : 'text-gray-900'
  const metaCls = picked ? 'text-gray-400' : 'text-gray-500'
  const at = timeAgo(picked ? (p.picked_up_at || p.updated_at || p.created_at) : (p.updated_at || p.created_at))
  const address = p.address || '未知取件点'

  // 丰巢等自提柜可能根本没有取件码，此时留白会让人以为页面出错，明确写出占位文案。
  // 占位块高度对齐取件码行高，避免同一行内卡片高度参差。
  const codeHtml = p.pickup_code
    ? `<div class="min-w-0 truncate code-font font-bold text-[30px] lg:text-[44px] leading-none tracking-wider ${codeCls}">${escapeHtml(formatCode(p.pickup_code))}</div>`
    : '<div class="min-w-0 h-[30px] lg:h-[44px] flex items-center text-base lg:text-lg font-medium leading-none text-gray-400">未获取到取件码</div>'

  return `
    <div class="${cardCls}" data-id="${p.id}">
      <div class="flex items-center gap-3 lg:block">
        ${codeHtml}
        <div class="ml-auto lg:hidden flex-shrink-0">${picked ? PICKED_BADGE_MB : PICKUP_BTN_MB}</div>
      </div>

      <div class="mt-2 lg:mt-3.5 flex items-center gap-1.5 text-[13px] lg:text-sm ${metaCls}">${recipientLine(p)}</div>

      ${p.mail_no ? `<div class="mt-1 text-[11px] lg:text-xs text-gray-400 code-font truncate">${escapeHtml(p.mail_no)}</div>` : ''}

      <div class="mt-2.5 lg:mt-3.5 pt-2.5 lg:pt-3.5 border-t ${picked ? 'border-gray-200/70' : 'border-gray-100'} flex items-center justify-between gap-3">
        <span class="hidden lg:flex items-center gap-1.5 text-xs text-gray-400 flex-shrink-0"><svg class="ico w-3.5 h-3.5"><use href="#i-clock"/></svg>${at}</span>
        <span class="flex lg:hidden items-center gap-1.5 text-[11px] text-gray-400 truncate"><svg class="ico w-3.5 h-3.5 flex-shrink-0"><use href="#i-pin"/></svg>${escapeHtml(address)}</span>
        <span class="flex lg:hidden items-center gap-1.5 text-[11px] text-gray-400 flex-shrink-0"><svg class="ico w-3.5 h-3.5"><use href="#i-clock"/></svg>${at}</span>
        <span class="hidden lg:inline-flex flex-shrink-0">${picked ? PICKED_BADGE_PC : PICKUP_BTN_PC}</span>
      </div>
    </div>
  `
}

function renderGroup(color, title, countText, items) {
  return `
    <section>
      <div class="flex items-start gap-2.5 mb-3">
        <span class="w-1 h-4 lg:h-5 mt-1 rounded-full ${color} flex-shrink-0"></span>
        <svg class="ico w-4 h-4 mt-1 text-gray-400 flex-shrink-0"><use href="#i-pin"/></svg>
        <h2 class="min-w-0 text-base lg:text-lg font-semibold break-words">${escapeHtml(title)}</h2>
        <span class="mt-0.5 text-[11px] lg:text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap">${countText}</span>
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-2.5 lg:gap-4">
        ${items.map(renderItem).join('')}
      </div>
    </section>
  `
}

/* ───────────── 移动端渲染 ───────────── */

function mbTimeLabel(p) {
  return p.status === 'picked_up'
    ? `已取 ${fmtStamp(p.picked_up_at || p.updated_at || p.created_at)}`
    : `更新 ${fmtStamp(p.updated_at || p.created_at)}`
}

/** 待取件卡片：码 + 取件按钮 + 收件人 + 快递号/更新时间 */
function renderMbPending(p, showAddress) {
  const codeHtml = p.pickup_code
    ? `<p class="flex-1 min-w-0 truncate code-font text-[30px] font-bold tracking-wider leading-none text-gray-900">${escapeHtml(formatCode(p.pickup_code))}</p>`
    : '<p class="flex-1 min-w-0 truncate text-base font-medium leading-none text-gray-400">未获取到取件码</p>'

  return `
    <div class="bg-white rounded-2xl border border-gray-200 card-shadow p-4" data-id="${p.id}">
      <div class="flex items-center gap-3">
        ${codeHtml}
        <button class="js-pickup-mb h-10 px-4 rounded-xl bg-primary text-white text-[13px] font-medium flex-shrink-0">取件</button>
      </div>
      <p class="mt-2 text-[13px] text-gray-500 flex items-center gap-1.5">${recipientLine(p)}</p>
      ${showAddress && p.address ? `<p class="mt-1.5 text-[12px] text-gray-400 flex items-center gap-1.5"><svg class="ico w-3.5 h-3.5 flex-shrink-0"><use href="#i-pin"/></svg><span class="truncate">${escapeHtml(p.address)}</span></p>` : ''}
      <div class="mt-2.5 pt-2.5 border-t border-gray-100 flex items-center justify-between gap-3 text-[11px] text-gray-400">
        <span class="code-font truncate">${escapeHtml(p.mail_no || '—')}</span>
        <span class="flex items-center gap-1 flex-shrink-0"><svg class="ico w-3 h-3"><use href="#i-clock"/></svg>${escapeHtml(mbTimeLabel(p))}</span>
      </div>
    </div>`
}

/** 已取件折叠行：默认只显示码与取走时间，点击展开详情 */
function renderMbPickedRow(p) {
  const title = p.pickup_code ? formatCode(p.pickup_code) : (p.goods_name || '已取件')
  return `
    <div class="mb-picked" data-id="${p.id}">
      <button class="mb-picked-head w-full flex items-center gap-3 px-4 py-3 text-left">
        <span class="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0"><svg class="ico w-4 h-4"><use href="#i-check"/></svg></span>
        <span class="flex-1 min-w-0">
          <span class="block code-font text-base font-semibold text-gray-400 line-through decoration-gray-300 tracking-wide truncate">${escapeHtml(title)}</span>
          <span class="block text-[11px] text-gray-400 mt-0.5">${escapeHtml(mbTimeLabel(p))}</span>
        </span>
        <svg class="mb-picked-arrow ico w-4 h-4 text-gray-300 flex-shrink-0 transition-transform"><use href="#i-chevron-down"/></svg>
      </button>
      <div class="mb-picked-detail hidden px-4 pb-3 space-y-1.5 text-[11px] text-gray-500">
        <div class="pl-[44px] space-y-1.5">
          ${p.address ? `<p class="flex items-center gap-1.5"><svg class="ico w-3 h-3 text-gray-400 flex-shrink-0"><use href="#i-pin"/></svg><span class="truncate">${escapeHtml(p.address)}</span></p>` : ''}
          ${p.mail_no ? `<p class="code-font text-gray-400">${escapeHtml(p.mail_no)}</p>` : ''}
          <p class="text-gray-400">收件人 ${escapeHtml(maskRecipient(p.recipient) || '未知')}${p.phone ? ' · 尾号 ' + escapeHtml(maskPhone(p.phone)) : ''}</p>
        </div>
      </div>
    </div>`
}

/** 移动端分组：全部为已取件时合并成一个面板，行间用分隔线 */
function renderMbGroup(title, countText, items, showAddress) {
  const allPicked = items.length > 0 && items.every(p => p.status === 'picked_up')
  const body = allPicked
    ? `<div class="mx-4 bg-white rounded-2xl border border-gray-200 overflow-hidden divide-y divide-gray-100">${items.map(renderMbPickedRow).join('')}</div>`
    : `<div class="px-4 space-y-2.5">${items.map(p => renderMbPending(p, showAddress)).join('')}</div>`

  return `
    <section>
      <div class="flex items-center gap-2 px-4 mb-2">
        <svg class="ico w-3.5 h-3.5 text-gray-400 flex-shrink-0"><use href="#i-pin"/></svg>
        <h2 class="text-[13px] font-semibold truncate">${escapeHtml(title)}</h2>
        <span class="ml-auto text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap">${escapeHtml(countText)}</span>
      </div>
      ${body}
    </section>`
}

/** 移动端分组内容（按地址 / 按取件情况） */
function buildMbGroups(items) {
  if (groupBy === 'address') {
    const groups = {}
    for (const p of items) {
      const key = p.address || '其他'
      if (!groups[key]) groups[key] = []
      groups[key].push(p)
    }
    return Object.entries(groups)
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
      .map(([address, list]) => {
        sortItems(list)
        const pickedN = list.filter(p => p.status === 'picked_up').length
        const countText = pickedN ? `${list.length} 件 · ${pickedN} 件已取` : `${list.length} 件待取`
        return renderMbGroup(address, countText, list, false)
      })
      .join('')
  }

  const pending = items.filter(p => p.status === 'pending')
  const picked = items.filter(p => p.status === 'picked_up')
  let html = ''
  if (pending.length > 0) {
    sortItems(pending)
    html += renderMbGroup('待取件', `${pending.length} 件`, pending, true)
  }
  if (picked.length > 0) {
    sortItems(picked)
    html += renderMbGroup('已取件', `${picked.length} 件`, picked, true)
  }
  return html
}

function applyBtnState(el, active, base, activeCls, inactiveCls) {
  el.className = `${base} ${active ? activeCls : inactiveCls}`
}

function applySegState(el, active) {
  el.className = `mobile-seg flex-1 h-8 rounded-[10px] text-[13px] font-medium transition-colors ${active ? 'bg-primary text-white' : 'text-gray-500'}`
}

function syncToolbarState() {
  applyBtnState(groupAddressBtn, groupBy === 'address', GROUP_BASE, GROUP_ACTIVE, GROUP_INACTIVE)
  applyBtnState(groupStatusBtn, groupBy === 'status', GROUP_BASE, GROUP_ACTIVE, GROUP_INACTIVE)
  applyBtnState(filterAllBtn, filterStatus === 'all', FILTER_BASE, FILTER_ACTIVE, FILTER_INACTIVE)
  applyBtnState(filterPendingBtn, filterStatus === 'pending', FILTER_BASE, FILTER_ACTIVE, FILTER_INACTIVE)
  applyBtnState(filterPickedBtn, filterStatus === 'picked_up', FILTER_BASE, FILTER_ACTIVE, FILTER_INACTIVE)

  // 移动端：没有「全部」，pending 与 all 都归为「待取」
  const mbPending = filterStatus !== 'picked_up'
  applySegState(filterPendingMbBtn, mbPending)
  applySegState(filterPickedMbBtn, !mbPending)

  document.querySelectorAll('.group-opt').forEach(btn => {
    const on = btn.dataset.group === groupBy
    btn.classList.toggle('bg-gray-50', on)
    btn.querySelector('.opt-check').style.visibility = on ? 'visible' : 'hidden'
  })
}

/* ───────────── 取件 / 撤回 ───────────── */

let undoTimer = null
let undoId = null

function hideUndo() {
  clearTimeout(undoTimer)
  undoId = null
  undoToast.classList.add('hidden')
  undoToast.classList.remove('flex')
}

function showUndo(id) {
  undoId = id
  undoToast.classList.remove('hidden')
  undoToast.classList.add('flex')
  clearTimeout(undoTimer)
  undoTimer = setTimeout(hideUndo, 5000)
}

async function markPicked(id) {
  const p = packages.find(x => String(x.id) === String(id))
  if (!p || p.status === 'picked_up') return
  const prev = { status: p.status, picked_up_at: p.picked_up_at, updated_at: p.updated_at }

  // 乐观更新：先改本地再发请求，失败回滚
  p.status = 'picked_up'
  p.picked_up_at = nowStamp()
  p.updated_at = p.picked_up_at
  render()

  try {
    const res = await fetch(`api/packages/${id}/pickup`, { method: 'PATCH' })
    if (!res.ok) throw new Error('取件失败')
    Object.assign(p, await res.json())
    render()
    showUndo(p.id)
  } catch (e) {
    Object.assign(p, prev)
    render()
    showStatus('操作失败', false)
  }
}

undoBtn.addEventListener('click', async () => {
  const id = undoId
  if (!id) return
  hideUndo()

  const p = packages.find(x => String(x.id) === String(id))
  const prev = p ? { status: p.status, picked_up_at: p.picked_up_at, updated_at: p.updated_at } : null
  if (p) {
    p.status = 'pending'
    p.picked_up_at = null
    p.updated_at = nowStamp()
    render()
  }

  try {
    const res = await fetch(`api/packages/${id}/restore`, { method: 'PATCH' })
    if (!res.ok) throw new Error('撤回失败')
  } catch (e) {
    if (p && prev) Object.assign(p, prev)
    render()
    showStatus('撤回失败', false)
  }
})

function bindInteractions() {
  document.querySelectorAll('.pickup-btn, .js-pickup-mb').forEach(btn => {
    btn.addEventListener('click', () => markPicked(btn.closest('[data-id]').dataset.id))
  })

  // 已取件折叠行：点击展开/收起
  document.querySelectorAll('.mb-picked-head').forEach(btn => {
    btn.addEventListener('click', () => {
      const wrap = btn.closest('.mb-picked')
      const detail = wrap.querySelector('.mb-picked-detail')
      const arrow = wrap.querySelector('.mb-picked-arrow')
      const open = detail.classList.contains('hidden')
      detail.classList.toggle('hidden', !open)
      arrow.classList.toggle('rotate-180', open)
    })
  })
}

/* ───────────── 渲染 ───────────── */

function render() {
  const todayPicked = packages.filter(p => p.status === 'picked_up' && isToday(p.picked_up_at))
  const pendingAll = packages.filter(p => p.status === 'pending')

  let filtered = packages.filter(p => p.status === 'pending' || (p.status === 'picked_up' && isToday(p.picked_up_at)))
  if (filterStatus === 'pending') filtered = pendingAll
  else if (filterStatus === 'picked_up') filtered = todayPicked

  const mbFiltered = filterStatus === 'picked_up' ? todayPicked : pendingAll

  const pendingCount = pendingAll.length
  const pickedCount = todayPicked.length
  document.getElementById('countPendingPc').textContent = pendingCount
  document.getElementById('countPickedPc').textContent = pickedCount
  document.getElementById('countPendingMb').textContent = pendingCount
  document.getElementById('countPendingMbSeg').textContent = pendingCount
  document.getElementById('countPickedMbSeg').textContent = pickedCount
  document.getElementById('countAll').textContent = pendingCount + pickedCount
  document.getElementById('countPending').textContent = pendingCount
  document.getElementById('countPicked').textContent = pickedCount

  syncToolbarState()

  // 空态按当前可见布局判断（移动端没有「全部」）
  const isDesktop = window.matchMedia('(min-width: 1024px)').matches
  const activeEmpty = isDesktop ? filtered.length === 0 : mbFiltered.length === 0

  if (activeEmpty) {
    listPcEl.innerHTML = ''
    listMbEl.innerHTML = ''
    emptyEl.classList.remove('hidden')
    emptyEl.classList.add('flex')
    return
  }
  emptyEl.classList.add('hidden')
  emptyEl.classList.remove('flex')

  // 桌面：保持原有分组 + 三列卡片
  if (groupBy === 'address') {
    const groups = {}
    for (const p of filtered) {
      const key = p.address || '其他'
      if (!groups[key]) groups[key] = []
      groups[key].push(p)
    }

    const sortedGroups = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))

    listPcEl.innerHTML = sortedGroups.map(([address, items], gi) => {
      sortItems(items)
      const pickedInGroup = items.filter(p => p.status === 'picked_up').length
      const countText = pickedInGroup
        ? `${items.length} 件 · ${pickedInGroup} 件已取`
        : `${items.length} 件待取`
      return renderGroup(GROUP_COLORS[gi % GROUP_COLORS.length], address, countText, items)
    }).join('')

  } else {
    const pending = filtered.filter(p => p.status === 'pending')
    const picked = filtered.filter(p => p.status === 'picked_up')

    let html = ''
    if (pending.length > 0) {
      sortItems(pending)
      html += renderGroup('bg-emerald-500', '待取件', `${pending.length} 件`, pending)
    }
    if (picked.length > 0) {
      sortItems(picked)
      html += renderGroup('bg-gray-300', '已取件', `${picked.length} 件`, picked)
    }
    listPcEl.innerHTML = html
  }

  // 移动：卡片化 + 已取件折叠
  listMbEl.innerHTML = buildMbGroups([...mbFiltered])

  bindInteractions()
}

/* ───────────── 工具栏事件 ───────────── */

groupAddressBtn.addEventListener('click', () => { groupBy = 'address'; render() })
groupStatusBtn.addEventListener('click', () => { groupBy = 'status'; render() })
filterAllBtn.addEventListener('click', () => { filterStatus = 'all'; render() })
filterPendingBtn.addEventListener('click', () => { filterStatus = 'pending'; render() })
filterPickedBtn.addEventListener('click', () => { filterStatus = 'picked_up'; render() })

filterPendingMbBtn.addEventListener('click', () => { filterStatus = 'pending'; render() })
filterPickedMbBtn.addEventListener('click', () => { filterStatus = 'picked_up'; render() })

function setGroupSheet(open) {
  groupSheet.classList.toggle('hidden', !open)
  groupSheet.classList.toggle('flex', open)
}
groupMenuBtn.addEventListener('click', () => { syncToolbarState(); setGroupSheet(true) })
groupSheet.addEventListener('click', e => { if (e.target === groupSheet) setGroupSheet(false) })
document.querySelectorAll('.group-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    groupBy = btn.dataset.group
    setGroupSheet(false)
    render()
  })
})

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

const liveStatus = document.getElementById('liveStatus')

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
  liveStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-400 inline-block"></span>连接已断开，正在重连'
  showStatus('实时连接已断开，正在重连...', false)
}
evtSource.onopen = () => {
  liveStatus.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>实时同步中'
}

loadAll()

addEventListener('beforeunload', () => {
  if (window._mainController) window._mainController.abort()
  evtSource.close()
})
