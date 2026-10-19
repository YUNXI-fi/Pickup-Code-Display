const { Router } = require('express')
const { stmts } = require('../db')
const { broadcast } = require('../sse')
const taobao = require('../taobao')
const taobaoLogin = require('../taobaoLogin')
const accounts = require('../accounts')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''


/**
 * 判定是否在途（只有真正在途的才导入）。
 * 以稳定枚举 tradeStatus 白名单为准 —— 中文文案会随版本变化，
 * 曾因「交易成功」被误判为在途（代码里写的是「交易完成」），
 * 导致大量历史已完成订单被当成待取件导入。
 */
const IN_TRANSIT_TRADE_STATUS = new Set(['WAIT_BUYER_CONFIRM_GOODS'])
const DONE_PATTERNS = ['签收', '交易成功', '交易完成', '交易关闭', '已完成', '退款']

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  const pw = req.headers['x-admin-password']
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授权' })
  next()
}

function getAccount(id) { return id ? accounts.get('taobao', id) : null }
function getCookie(id) { const a = getAccount(id); return a ? a.cookie : '' }
function saveCookie(cookie, id, name) {
  const normalized = cookie.replace(/\s+/g, ' ').trim()
  const existing = getAccount(id)
  const account = { id: existing ? existing.id : accounts.normalizeId(id), name: name || (existing && existing.name) || `淘宝账号 ${accounts.list('taobao').length + 1}`, cookie: normalized, created_at: existing?.created_at || new Date().toISOString() }
  accounts.save('taobao', account)
  return account
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

module.exports = function (app) {
  const router = Router()

  router.get('/express/status', requireAuth, (req, res) => {
    const list = accounts.list('taobao')
    const last = stmts.lastSync.get()
    res.json({ cookie_set: list.length > 0, accounts: list.map(a => ({ id: a.id, name: a.name, cookie_set: !!a.cookie })), last_sync: last || null })
  })

  router.post('/express/cookie', requireAuth, (req, res) => {
    const { cookie, account_id, name } = req.body
    if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie 不能为空' })
    if (!/_m_h5_tk=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 _m_h5_tk，请从淘宝页面完整复制' })
    }
    const account = saveCookie(cookie, account_id, name)
    res.json({ ok: true, id: account.id, name: account.name, length: account.cookie.length })
  })

  /** 删除账号：清除已保存的淘宝 Cookie */
  router.delete('/express/cookie', requireAuth, (req, res) => {
    const id = req.query.account_id || req.body?.account_id
    if (id) accounts.remove('taobao', id)
    else accounts.list('taobao').forEach(a => accounts.remove('taobao', a.id))
    res.json({ ok: true })
  })

  /** 扫码登录：生成二维码（服务端本地渲染，token 不外传） */
  router.post('/express/qrcode', requireAuth, async (req, res) => {
    try {
      const r = await taobaoLogin.createQr()
      r.account_id = accounts.normalizeId(req.body?.account_id)
      res.json(r)
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  /** 扫码登录：轮询状态；确认后落库 Cookie 并校验登录态 */
  router.get('/express/qrcode/:sid', requireAuth, async (req, res) => {
    try {
      const r = await taobaoLogin.pollStatus(req.params.sid)
      if (r.status !== 'CONFIRMED') return res.json({ status: r.status })

      saveCookie(r.cookie, req.query.account_id || req.headers['x-account-id'])
      const v = await taobaoLogin.verifyLogin(r.cookie)
      stmts.logSync.run({
        source: 'taobao_login',
        status: v.ok ? 'ok' : 'error',
        detail: v.ok ? '扫码登录成功' : v.error,
      })
      if (!v.ok) {
        return res.status(502).json({ status: 'CONFIRMED', error: '已扫码，但登录态校验失败：' + v.error })
      }
      res.json({ status: 'CONFIRMED', ok: true })
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  router.post('/express/sync', requireAuth, async (req, res) => {
    const selected = req.body?.account_id || req.query.account_id
    const targets = selected ? [getAccount(selected)].filter(Boolean) : accounts.list('taobao')
    if (!targets.length) return res.status(400).json({ error: '请先添加淘宝账号' })

    const created = []
    const skipped = []
    const seen = new Set()

    /** 记录新增/升级的包裹：广播并收集新建项用于回显 */
    const commit = (r) => {
      if (!r.created && !r.promoted) return
      const row = stmts.getById.get(r.id)
      broadcast(r.created ? 'create' : 'update', row)
      if (r.created) created.push(row)
    }

    try {
      for (const account of targets) for (let page = 1; page <= 3; page++) {
        let orders
        try {
          orders = await taobao.fetchOrders(account.cookie, page)
        } catch (e) {
          if (page === 1) throw e
          break
        }
        if (orders.length === 0) break

        for (const o of orders) {
          if (!o.orderId || seen.has(o.orderId)) continue
          seen.add(o.orderId)

          const statusText = o.statusText || ''
          if (DONE_PATTERNS.some(p => statusText.includes(p))) {
            skipped.push({ order_id: o.orderId, reason: statusText || '已完成' })
            continue
          }

          // 待发货：尚无运单号与取件码，仅入库跟踪状态
          if (isToShip(o)) {
            commit(upsertPackage({ order_id: o.orderId, status: 'to_ship', goods_name: o.goodsName, source_platform: 'taobao' }))
            continue
          }

          if (!isInTransit(o)) {
            skipped.push({ order_id: o.orderId, reason: statusText || o.tradeStatus || '非在途' })
            continue
          }

          let parcel = null
          try {
            parcel = await taobao.fetchParcel(account.cookie, o.orderId)
          } catch (e) {
            // 单条物流页失败不影响整轮同步
          }
          if (!parcel || !parcel.mailNo) {
            skipped.push({ order_id: o.orderId, reason: '未获取到运单号' })
            continue
          }
          // 快递已签收的不必进待取列表：淘宝订单可能仍停留在「卖家已发货」，
          // 但承运商轨迹已签收 → 属于已完成，不是待取件
          if (parcel.stateLabel && parcel.stateLabel.includes('签收')) {
            skipped.push({ order_id: o.orderId, reason: '快递已签收', mail_no: parcel.mailNo })
            continue
          }

          // 取件码直接来自淘宝 SSR 页面的结构化字段 cardDesc.custom.expressCode；
          // 有取件码 = 已到驿站（待取件），无取件码 = 仍在运输中
          const code = parcel.pickupCode || ''
          commit(upsertPackage({
            order_id: o.orderId,
            mail_no: parcel.mailNo,
            status: code ? 'pending' : 'shipping',
            pickup_code: code,
            company: parcel.cpName || '',
            recipient: parcel.recipient || '',
            phone: parcel.phone || '',
            address: parcel.station || '',
            goods_name: o.goodsName,
            source_platform: 'taobao',
          }))
        }
        if (orders.length < 10) break
      }
    } catch (e) {
      stmts.logSync.run({ source: 'taobao', status: 'error', detail: e.message })
      return res.status(502).json({ error: e.message })
    }

    const detail = `新增 ${created.length} / 跳过 ${skipped.length}`
    stmts.logSync.run({ source: 'taobao', status: 'ok', detail })

    for (const c of created) broadcast('create', stmts.getById.get(c.id))
    res.json({ ok: true, created, skipped, summary: detail })
  })

  /** 刷新取件码/驿站/收件人：按订单号重取淘宝 SSR 物流页（无第三方依赖） */
  router.post('/express/fill-codes', requireAuth, async (req, res) => {
    const selected = req.body?.account_id || req.query.account_id
    const targets = selected ? [getAccount(selected)].filter(Boolean) : accounts.list('taobao')
    if (!targets.length) return res.status(400).json({ error: '请先添加淘宝账号' })

    const rows = stmts.withOrderId.all()
    if (rows.length === 0) {
      return res.json({ ok: true, filled: [], missed: [], message: '没有可刷新的待取包裹' })
    }

    const filled = []
    const missed = []
    for (const row of rows) {
      let parcel = null
      let lastError = null
      for (const account of targets) {
        try {
          parcel = await taobao.fetchParcel(account.cookie, row.order_id)
          if (parcel) break
        } catch (e) { lastError = e }
      }
      if (!parcel) {
        missed.push({ id: row.id, mail_no: row.mail_no, reason: lastError?.message || '未取到物流数据（登录态或订单可能已变化）' })
        continue
      }
      const code = parcel.pickupCode || ''
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
      })
      // 运输中的包裹一旦取到取件码即已到驿站，推进为待取件
      if (gotCode && row.status === 'shipping') {
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
