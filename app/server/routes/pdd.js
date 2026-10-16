const { Router } = require('express')
const { stmts } = require('../db')
const { broadcast } = require('../sse')
const pdd = require('../pdd')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const COOKIE_KEY = 'pdd_cookie'

// 与淘宝渠道同构：状态只前进，已取件为终态
const STATUS_RANK = { to_ship: 1, shipping: 2, pending: 3, picked_up: 4 }

// 拼多多订单状态文案判定（order_status_prompt）
const DONE_PATTERNS = ['已评价', '交易成功', '交易完成', '交易关闭', '已完成', '退款']
const TO_SHIP_PATTERNS = ['待发货', '等待发货', '待卖家发货']
const IN_TRANSIT_PROMPTS = ['待发货', '待收货']

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授权' })
  next()
}

function getCookie() {
  const row = stmts.getSetting.get(COOKIE_KEY)
  return row && row.value ? row.value : ''
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

module.exports = function (app) {
  const router = Router()

  router.get('/pdd/status', requireAuth, (req, res) => {
    res.json({ cookie_set: !!getCookie() })
  })

  router.post('/pdd/cookie', requireAuth, (req, res) => {
    const { cookie } = req.body
    if (!cookie || !cookie.trim()) return res.status(400).json({ error: 'Cookie 不能为空' })
    if (!/PDDAccessToken=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 PDDAccessToken，请登录 mobile.yangkeduo.com 后完整复制' })
    }
    if (!/pdd_user_id=|pdduid=/.test(cookie)) {
      return res.status(400).json({ error: 'Cookie 中缺少 pdd_user_id，请确认已登录' })
    }
    const normalized = cookie.replace(/\s+/g, ' ').trim()
    stmts.setSetting.run({ key: COOKIE_KEY, value: normalized })
    res.json({ ok: true })
  })

  /** 删除账号：清除已保存的拼多多 Cookie */
  router.delete('/pdd/cookie', requireAuth, (req, res) => {
    stmts.deleteSetting.run(COOKIE_KEY)
    res.json({ ok: true })
  })

  router.post('/pdd/sync', requireAuth, async (req, res) => {
    const cookie = getCookie()
    if (!cookie) return res.status(400).json({ error: '请先保存拼多多 Cookie' })

    const created = []
    const skipped = []
    const seen = new Set()

    try {
      let offset = ''
      for (let page = 1; page <= 5; page++) {
        const orders = await pdd.fetchOrders(cookie, { page, offset })
        if (orders.length === 0) break

        for (const o of orders) {
          if (!o.order_sn || seen.has(o.order_sn)) continue
          seen.add(o.order_sn)

          const prompt = o.order_status_prompt || ''
          if (DONE_PATTERNS.some(p => prompt.includes(p))) {
            skipped.push({ order_id: o.order_sn, reason: prompt || '已完成' })
            continue
          }
          if (!IN_TRANSIT_PROMPTS.some(p => prompt.includes(p))) {
            skipped.push({ order_id: o.order_sn, reason: prompt || '非在途' })
            continue
          }

          // 与淘宝渠道一致：在途订单也入库跟踪；
          // 到驿站/柜后 cabinet 接口返回取件码，否则为空
          let code = ''
          if (o.tracking_number) {
            const pick = await pdd.fetchPickupCode(cookie, o)
            code = pick.code
          }

          const toShip = !o.tracking_number || TO_SHIP_PATTERNS.some(p => prompt.includes(p))
          const r = upsertPackage({
            order_id: o.order_sn,
            mail_no: o.tracking_number || '',
            status: code ? 'pending' : (toShip ? 'to_ship' : 'shipping'),
            pickup_code: code,
            company: '',
            recipient: '',
            phone: '',
            address: '',
            goods_name: pdd.goodsNameOf(o),
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
    } catch (e) {
      stmts.logSync.run({ source: 'pdd', status: 'error', detail: e.message })
      return res.status(502).json({ error: e.message })
    }

    const detail = `新增 ${created.length} / 跳过 ${skipped.length}`
    stmts.logSync.run({ source: 'pdd', status: 'ok', detail })
    res.json({ ok: true, created, skipped, summary: detail })
  })

  app.use('/api', router)
}
