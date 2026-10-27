const { Router } = require('express')
const { stmts } = require('../db')
const { broadcast } = require('../sse')
const pdd = require('../pdd')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const PLATFORM = 'pdd'

// 与淘宝渠道同构：状态只前进，已取件为终态
const STATUS_RANK = { to_ship: 1, shipping: 2, pending: 3, picked_up: 4 }

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授权' })
  next()
}

/** 命中已有记录（订单号优先、运单号兜底）则刷新字段，否则插入 */
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

  /** 账号列表（不含 cookie） */
  router.get('/pdd/accounts', requireAuth, (req, res) => {
    const rows = stmts.listAccounts.all(PLATFORM)
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
      last_sync: stmts.lastSyncBySource.get(PLATFORM) || null,
    })
  })

  /** 新增账号（粘贴 Cookie） */
  router.post('/pdd/accounts', requireAuth, (req, res) => {
    const { cookie, remark } = req.body
    if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie 不能为空' })
    if (!/PDDAccessToken=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 PDDAccessToken，请登录 mobile.yangkeduo.com 后完整复制' })
    }
    if (!/pdd_user_id=|pdduid=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 pdd_user_id，请确认已登录' })
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
  router.patch('/pdd/accounts/:id', requireAuth, (req, res) => {
    const acc = stmts.getAccount.get(req.params.id)
    if (!acc || acc.platform !== PLATFORM) return res.status(404).json({ error: '账号不存在' })

    const { cookie, remark } = req.body
    if (cookie !== undefined) {
      if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie 不能为空' })
      if (!/PDDAccessToken=/.test(cookie)) {
        return res.status(400).json({ error: 'Cookie 中缺少 PDDAccessToken，请登录 mobile.yangkeduo.com 后完整复制' })
      }
      if (!/pdd_user_id=|pdduid=/.test(cookie)) {
        return res.status(400).json({ error: 'Cookie 中缺少 pdd_user_id，请确认已登录' })
      }
      stmts.updateAccountCookie.run({ id: acc.id, cookie: cookie.replace(/\s+/g, ' ').trim() })
    }
    if (remark !== undefined) {
      stmts.updateAccountRemark.run({ id: acc.id, remark: String(remark).trim() || null })
    }
    res.json({ ok: true })
  })

  /** 只同步单个账号（账号编辑页的「更新快递」） */
  router.post('/pdd/accounts/:id/sync', requireAuth, async (req, res) => {
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
  router.delete('/pdd/accounts/:id', requireAuth, (req, res) => {
    const acc = stmts.getAccount.get(req.params.id)
    if (!acc || acc.platform !== PLATFORM) return res.status(404).json({ error: '账号不存在' })
    stmts.deleteAccount.run(acc.id)
    res.json({ ok: true })
  })

  /** 同步单个账号的拼多多订单 */
  async function syncAccount(acc, created, skipped) {
    const seen = new Set()
    let offset = ''
    for (let page = 1; page <= 5; page++) {
      const orders = await pdd.fetchOrders(acc.cookie, { page, offset })
      if (orders.length === 0) break

      for (const o of orders) {
        if (!o.order_sn || seen.has(o.order_sn)) continue
        seen.add(o.order_sn)

        // 有取件码 → 待取件；只拿到运单号 → 运输中（与淘宝一致：在途也入库）
        const pick = await pdd.fetchPickupCode(acc.cookie, o)
        const code = pick.code || ''
        if (!code && !o.tracking_number) {
          skipped.push({ order_id: o.order_sn, reason: '无运单号且暂无取件码' })
          continue
        }

        const r = upsertPackage({
          order_id: o.order_sn,
          mail_no: o.tracking_number || '',
          status: code ? 'pending' : 'shipping',
          pickup_code: code,
          company: pick.company,
          recipient: '',
          phone: '',
          address: pick.address,
          goods_name: pdd.goodsNameOf(o),
          account_id: acc.id,
        })
        if (r.created || r.promoted) {
          const row = stmts.getById.get(r.id)
          broadcast(r.created ? 'create' : 'update', row)
          if (r.created) created.push(row)
        }
      }

      const last = orders[orders.length - 1]
      if (!last || !last.offset || orders.length < 10) break
      offset = String(last.offset)
    }

    // 已不在「待收货」列表里的本地包裹 = 已签收/已取走。
    // 拼多多签收后订单会离开该标签页，不清理的话运输中/待取件记录会永远留在列表。
    for (const row of stmts.withOrderId.all()) {
      if (row.account_id !== acc.id || seen.has(row.order_id)) continue
      const info = stmts.markPicked.run(row.id)
      if (info.changes === 0) continue
      broadcast('update', stmts.getById.get(row.id))
    }
  }

  /** 同步所有拼多多账号的订单 */
  router.post('/pdd/sync', requireAuth, async (req, res) => {
    const accounts = stmts.allAccounts.all(PLATFORM)
    if (accounts.length === 0) return res.status(400).json({ error: '请先添加拼多多账号' })

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
        stmts.logSync.run({ source: 'pdd', status: 'error', detail: `账号#${acc.id} ${e.message}` })
      }
    }

    const detail = `账号 ${accounts.length} 个 / 新增 ${created.length} / 跳过 ${skipped.length}` +
      (errors.length ? ` / 失败 ${errors.length}` : '')
    stmts.logSync.run({ source: 'pdd', status: errors.length === accounts.length ? 'error' : 'ok', detail })
    res.json({ ok: true, created, skipped, errors, summary: detail })
  })

  app.use('/api', router)
}
