const { Router } = require('express')
const { stmts } = require('../db')
const { broadcast } = require('../sse')
const taobao = require('../taobao')
const taobaoLogin = require('../taobaoLogin')
const settings = require('../settings')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const PLATFORM = 'taobao'

/**
 * 判定是否在途（只有真正在途的才导入）。
 * 以稳定枚举 tradeStatus 白名单为准 —— 中文文案会随版本变化，
 * 曾因「交易成功」被误判为在途（代码里写的是「交易完成」），
 * 导致大量历史已完成订单被当成待取件导入。
 */
const IN_TRANSIT_TRADE_STATUS = new Set(['WAIT_BUYER_CONFIRM_GOODS'])
const DONE_PATTERNS = ['签收', '交易成功', '交易完成', '交易关闭', '已完成', '退款']
/** 明确代表「已签收/已完成」的文案（交易关闭、退款不算已取件） */
const PICKED_PATTERNS = ['签收', '交易成功', '交易完成', '已完成']

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  const pw = req.headers['x-admin-password']
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授权' })
  next()
}

/** 在途判定：先看稳定枚举，再用文案兜底 */
function isInTransit(order) {
  if (!IN_TRANSIT_TRADE_STATUS.has(order.tradeStatus)) return false
  const t = order.statusText || ''
  return !DONE_PATTERNS.some(p => t.includes(p))
}

/** 待发货判定：枚举优先，文案兜底 */
const TO_SHIP_PATTERNS = ['待发货', '等待卖家发货', '待卖家发货']
function isToShip(order) {
  if (order.tradeStatus === 'WAIT_SELLER_SEND_GOODS') return true
  const t = order.statusText || ''
  return TO_SHIP_PATTERNS.some(p => t.includes(p))
}

// 状态只前进：待发货 → 运输中 → 待取件 →（人工）已取件
const STATUS_RANK = { to_ship: 1, shipping: 2, pending: 3, picked_up: 4 }

/** 命中已有记录（订单号优先、运单号兜底）则刷新字段并按需推进状态，否则插入 */
function upsertPackage(p) {
  let existing = p.order_id ? stmts.getByOrderId.get(p.order_id) : null
  if (!existing && p.mail_no) existing = stmts.getByMailNo.get(p.mail_no)

  if (!existing) {
    const info = stmts.insertExpress.run(p)
    return { id: info.lastInsertRowid, created: true, promoted: false }
  }

  stmts.updateExpressInfo.run({ ...p, id: existing.id })
  const advanced = existing.status !== 'picked_up'
    && (STATUS_RANK[p.status] || 0) > (STATUS_RANK[existing.status] || 0)
  if (advanced) stmts.promoteStatus.run({ id: existing.id, status: p.status })
  return { id: existing.id, created: false, promoted: advanced }
}

/** 各账号名下在途/待取件包裹数 */
function accountCounts() {
  const map = {}
  for (const r of stmts.accountStatusCounts.all()) {
    const c = map[r.account_id] || (map[r.account_id] = { shipping: 0, pending: 0 })
    c[r.status] = r.n
  }
  return map
}

module.exports = function (app) {
  const router = Router()

  /** 订单已完成：若本地已有未取件记录，同步标记为已取件 */
  function markPickedByOrderId(orderId) {
    const existing = stmts.getByOrderId.get(orderId)
    if (!existing || existing.status === 'picked_up') return
    const info = stmts.markPicked.run(existing.id)
    if (info.changes === 0) return
    broadcast('update', stmts.getById.get(existing.id))
  }

  /** 账号列表（不含 cookie） */
  router.get('/express/accounts', requireAuth, (req, res) => {
    const rows = stmts.listAccounts.all(PLATFORM)
    const last = stmts.lastSyncBySource.get(PLATFORM)
    const counts = accountCounts()
    res.json({
      accounts: rows.map(a => ({
        id: a.id,
        remark: a.remark || '',
        created_at: a.created_at,
        last_sync_at: a.last_sync_at || null,
        last_sync_status: a.last_sync_status || null,
        shipping: (counts[a.id] || {}).shipping || 0,
        pending: (counts[a.id] || {}).pending || 0,
      })),
      last_sync: last || null,
    })
  })

  /** 新增账号（粘贴 Cookie） */
  router.post('/express/accounts', requireAuth, (req, res) => {
    const { cookie, remark } = req.body
    if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie 不能为空' })
    if (!/_m_h5_tk=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 _m_h5_tk，请从淘宝页面完整复制' })
    }
    const normalized = cookie.replace(/\s+/g, ' ').trim()
    const info = stmts.insertAccount.run({
      platform: PLATFORM,
      cookie: normalized,
      remark: String(remark || '').trim() || null,
    })
    res.json({ ok: true, id: info.lastInsertRowid })
  })

  /** 修改账号：备注 / 重新设置 Cookie（登录失效时用） */
  router.patch('/express/accounts/:id', requireAuth, (req, res) => {
    const acc = stmts.getAccount.get(req.params.id)
    if (!acc || acc.platform !== PLATFORM) return res.status(404).json({ error: '账号不存在' })

    const { cookie, remark } = req.body
    if (cookie !== undefined) {
      if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie 不能为空' })
      if (!/_m_h5_tk=/.test(cookie)) {
        return res.status(400).json({ error: 'Cookie 中缺少 _m_h5_tk，请从淘宝页面完整复制' })
      }
      stmts.updateAccountCookie.run({ id: acc.id, cookie: cookie.replace(/\s+/g, ' ').trim() })
    }
    if (remark !== undefined) {
      stmts.updateAccountRemark.run({ id: acc.id, remark: String(remark).trim() || null })
    }
    res.json({ ok: true })
  })

  /** 只同步单个账号（账号编辑页的「更新快递」） */
  router.post('/express/accounts/:id/sync', requireAuth, async (req, res) => {
    const acc = stmts.getAccount.get(req.params.id)
    if (!acc || acc.platform !== PLATFORM) return res.status(404).json({ error: '账号不存在' })

    const created = []
    const skipped = []
    try {
      await syncAccount(acc, created, skipped)
      stmts.updateAccountSync.run({ id: acc.id, status: 'ok', detail: null })
      stmts.logSync.run({ source: PLATFORM, status: 'ok', detail: `账号#${acc.id} 新增 ${created.length} / 跳过 ${skipped.length}` })
      res.json({ ok: true, created, skipped, summary: `新增 ${created.length} 件，跳过 ${skipped.length} 件` })
    } catch (e) {
      stmts.updateAccountSync.run({ id: acc.id, status: 'error', detail: e.message })
      stmts.logSync.run({ source: PLATFORM, status: 'error', detail: `账号#${acc.id} ${e.message}` })
      res.status(502).json({ error: e.message })
    }
  })

  /** 删除账号 */
  router.delete('/express/accounts/:id', requireAuth, (req, res) => {
    const acc = stmts.getAccount.get(req.params.id)
    if (!acc || acc.platform !== PLATFORM) return res.status(404).json({ error: '账号不存在' })
    stmts.deleteAccount.run(acc.id)
    res.json({ ok: true })
  })

  /** 扫码登录：生成二维码（服务端本地渲染，token 不外传） */
  router.post('/express/qrcode', requireAuth, async (req, res) => {
    try {
      res.json(await taobaoLogin.createQr())
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  /** 扫码登录：轮询状态；确认后新增一个账号并校验登录态 */
  router.get('/express/qrcode/:sid', requireAuth, async (req, res) => {
    try {
      const r = await taobaoLogin.pollStatus(req.params.sid)
      if (r.status !== 'CONFIRMED') return res.json({ status: r.status })

      const v = await taobaoLogin.verifyLogin(r.cookie)
      stmts.logSync.run({
        source: 'taobao_login',
        status: v.ok ? 'ok' : 'error',
        detail: v.ok ? '扫码登录成功' : v.error,
      })
      if (!v.ok) {
        return res.status(502).json({ status: 'CONFIRMED', error: '已扫码，但登录态校验失败：' + v.error })
      }
      const normalized = r.cookie.replace(/\s+/g, ' ').trim()
      const info = stmts.insertAccount.run({ platform: PLATFORM, cookie: normalized, remark: null })
      res.json({ status: 'CONFIRMED', ok: true, id: info.lastInsertRowid })
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  /** 同步单个账号的快递单，命中新增/升级时写入并广播 */
  async function syncAccount(acc, created, skipped) {
    const { showProxy, keywords } = settings.getDisplaySettings()
    const orders = []
    for (let page = 1; page <= 3; page++) {
      let pageOrders
      try {
        pageOrders = await taobao.fetchOrders(acc.cookie, page)
      } catch (e) {
        if (page === 1) throw e
        break
      }
      if (pageOrders.length === 0) break
      orders.push(...pageOrders)
      if (pageOrders.length < 10) break
    }

    // 待收货列表的取件码（拆单订单的取件码只在订单列表返回，物流详情页没有）
    const pickupCodes = await taobao.fetchPickupCodes(acc.cookie)

    const commit = (r) => {
      if (!r.created && !r.promoted) return
      const row = stmts.getById.get(r.id)
      // 隐藏的代取件不计入「新增」统计（是否推送由 sse 出口统一过滤）
      if (!showProxy && settings.isProxyRow(row, keywords)) return
      broadcast(r.created ? 'create' : 'update', row)
      if (r.created) created.push(row)
    }

    const seen = new Set()
    for (const o of orders) {
      if (!o.orderId || seen.has(o.orderId)) continue
      seen.add(o.orderId)

      const statusText = o.statusText || ''
      if (DONE_PATTERNS.some(p => statusText.includes(p))) {
        // 订单已完成 → 把本地已有的待取记录同步改为已取件（历史订单仍不导入）
        if (PICKED_PATTERNS.some(p => statusText.includes(p))) markPickedByOrderId(o.orderId)
        skipped.push({ order_id: o.orderId, reason: statusText || '已完成' })
        continue
      }

      // 待发货：尚无运单号与取件码，仅入库跟踪状态
      if (isToShip(o)) {
        commit(upsertPackage({ order_id: o.orderId, status: 'to_ship', goods_name: o.goodsName, account_id: acc.id }))
        continue
      }

      if (!isInTransit(o)) {
        skipped.push({ order_id: o.orderId, reason: statusText || o.tradeStatus || '非在途' })
        continue
      }

      let parcel = null
      try {
        parcel = await taobao.fetchParcel(acc.cookie, o.orderId)
      } catch (e) {
        // 单条物流页失败不影响整轮同步
      }
      if (!parcel || !parcel.mailNo) {
        skipped.push({ order_id: o.orderId, reason: '未获取到运单号' })
        continue
      }
      // 自提柜/驿站：入柜后凭取货码取走 → 已取件
      if (parcel.picked) {
        markPickedByOrderId(o.orderId)
        skipped.push({ order_id: o.orderId, reason: '已取件', mail_no: parcel.mailNo })
        continue
      }
      // 已签收且不在自提柜/驿站 → 属于已完成，不是待取件
      if (parcel.stateLabel && parcel.stateLabel.includes('签收') && !parcel.atPickupPoint) {
        // 已签收且不在自提柜/驿站 → 视为已取件
        markPickedByOrderId(o.orderId)
        skipped.push({ order_id: o.orderId, reason: '快递已签收', mail_no: parcel.mailNo })
        continue
      }

      // 有取件码（物流页或订单列表）、或已到达自提柜/驿站（可能无码，如丰巢）→ 待取件
      const code = parcel.pickupCode || pickupCodes[o.orderId] || ''
      commit(upsertPackage({
        order_id: o.orderId,
        mail_no: parcel.mailNo,
        status: (code || parcel.atPickupPoint) ? 'pending' : 'shipping',
        pickup_code: code,
        company: parcel.cpName || '',
        recipient: parcel.recipient || '',
        phone: parcel.phone || '',
        address: parcel.station || '',
        goods_name: o.goodsName,
        account_id: acc.id,
        proxy: settings.isProxyText(parcel.hintText, keywords) ? 1 : 0,
      }))
    }
  }

  /** 同步所有淘宝账号的在途订单 */
  router.post('/express/sync', requireAuth, async (req, res) => {
    const accounts = stmts.allAccounts.all(PLATFORM)
    if (accounts.length === 0) return res.status(400).json({ error: '请先添加淘宝账号' })

    const created = []
    const skipped = []
    const errors = []
    for (const acc of accounts) {
      try {
        await syncAccount(acc, created, skipped)
        stmts.updateAccountSync.run({ id: acc.id, status: 'ok', detail: null })
      } catch (e) {
        errors.push({ account_id: acc.id, remark: acc.remark || '', error: e.message })
        stmts.updateAccountSync.run({ id: acc.id, status: 'error', detail: e.message })
        stmts.logSync.run({ source: 'taobao', status: 'error', detail: `账号#${acc.id} ${e.message}` })
      }
    }

    const detail = `账号 ${accounts.length} 个 / 新增 ${created.length} / 跳过 ${skipped.length}` +
      (errors.length ? ` / 失败 ${errors.length}` : '')
    stmts.logSync.run({ source: 'taobao', status: errors.length === accounts.length ? 'error' : 'ok', detail })

    for (const c of created) broadcast('create', stmts.getById.get(c.id))
    res.json({ ok: true, created, skipped, errors, summary: detail })
  })

  /** 刷新取件码/驿站/收件人：按订单号重取淘宝 SSR 物流页（无第三方依赖） */
  router.post('/express/fill-codes', requireAuth, async (req, res) => {
    const accounts = stmts.allAccounts.all(PLATFORM)
    if (accounts.length === 0) return res.status(400).json({ error: '请先添加淘宝账号' })

    const { keywords } = settings.getDisplaySettings()
    const rows = stmts.withOrderId.all()
    if (rows.length === 0) {
      return res.json({ ok: true, filled: [], missed: [], message: '没有可刷新的待取包裹' })
    }

    // 每个账号的取件码表（拆单订单的取件码只在订单列表返回）
    const codesByAccount = {}
    for (const acc of accounts) {
      try { codesByAccount[acc.id] = await taobao.fetchPickupCodes(acc.cookie) } catch (e) { codesByAccount[acc.id] = {} }
    }
    const cookieById = {}
    for (const acc of accounts) cookieById[acc.id] = acc.cookie

    const filled = []
    const missed = []
    for (const row of rows) {
      // 优先用包裹归属的账号；无归属（旧数据）则逐个账号尝试
      const candidates = (row.account_id && cookieById[row.account_id])
        ? [row.account_id]
        : accounts.map(a => a.id)

      let parcel = null
      let usedAccount = null
      for (const aid of candidates) {
        try {
          parcel = await taobao.fetchParcel(cookieById[aid], row.order_id)
        } catch (e) {
          parcel = null
        }
        if (parcel) { usedAccount = aid; break }
      }
      if (!parcel) {
        missed.push({ id: row.id, mail_no: row.mail_no, reason: '未取到物流数据（登录态或订单可能已变化）' })
        continue
      }

      // 自提柜/驿站：入柜后凭取货码取走 → 已取件
      if (parcel.picked) {
        stmts.markPicked.run(row.id)
        broadcast('update', stmts.getById.get(row.id))
        continue
      }

      const code = parcel.pickupCode || (codesByAccount[usedAccount] || {})[row.order_id] || ''
      // 仅当本次新拿到取件码才计入 filled，避免把仍在运输（无取件码）的包裹
      // 也算作「刷新取件码」，导致提示数量与列表实际不符
      const gotCode = !!code && !row.pickup_code
      stmts.updateExpressInfo.run({
        id: row.id,
        pickup_code: code,
        company: parcel.cpName || '',
        recipient: parcel.recipient || '',
        phone: parcel.phone || '',
        address: parcel.station || '',
        proxy: settings.isProxyText(parcel.hintText, keywords) ? 1 : 0,
      })
      // 运输中的包裹一旦取到取件码、或已到达自提柜/驿站，即推进为待取件
      if (row.status === 'shipping' && (gotCode || parcel.atPickupPoint)) {
        stmts.promoteStatus.run({ id: row.id, status: 'pending' })
      }
      const updated = stmts.getById.get(row.id)
      if (gotCode) {
        filled.push({
          id: row.id,
          mail_no: row.mail_no,
          pickup_code: updated.pickup_code,
          address: updated.address,
          recipient: updated.recipient,
          phone: updated.phone,
        })
      }
      broadcast('update', updated)
    }

    res.json({ ok: true, filled, missed })
  })

  app.use('/api', router)
}
