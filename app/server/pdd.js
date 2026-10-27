/**
 * 拼多多 H5 采集（登录态 = mobile.yangkeduo.com 的 Cookie）。
 *
 * 实测结论（2026-10）：
 * - order_list_v4：只需 Cookie，**不需要 anti_content 签名**，返回订单 + 运单号。
 *   type=unreceived 只返回「待收货」订单；type=all 会带上历史已完成订单，
 *   这些老订单的驿站/柜记录依然存在，会连同旧取件码一起捞回来，必须避免。
 * - express/cabinet/{order_sn}：自提柜/驿站，**同样不需要签名**，
 *   result.code 即取件码（前端渲染为「取件碼：<code>」并生成 ConsumerPickUp;<code> 二维码）。
 *   **不能带任何查询参数**：带 external=1 等参数会走「外部来源」分支，
 *   返回 success=true 但 result 只有 status:0、无 code 的降级结果。
 * - express/shipping/track：入参含 antiContent，服务端无法自算 → 不使用
 */
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Mobile Safari/537.36'
const BASE = 'https://mobile.yangkeduo.com'
const TIMEOUT = 20000

function headers(cookie) {
  return {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: `${BASE}/orders.html`,
    Cookie: cookie,
  }
}

function extractUid(cookie) {
  const m = cookie.match(/pdd_user_id=([^;]+)/) || cookie.match(/pdduid=([^;]+)/)
  return m ? m[1].trim() : ''
}

/** 订单列表；返回原始订单对象数组 */
async function fetchOrders(cookie, { page = 1, offset = '' } = {}) {
  const uid = extractUid(cookie)
  if (!uid) throw new Error('Cookie 中缺少 pdd_user_id，请重新从网页版复制')

  const qs = { pdduid: uid, page: String(page), type: 'unreceived' }
  if (offset) qs.offset = String(offset)
  const url = `${BASE}/proxy/api/api/aristotle/order_list_v4?${new URLSearchParams(qs)}`

  const r = await fetch(url, { headers: headers(cookie), signal: AbortSignal.timeout(TIMEOUT) })
  const text = await r.text()
  let j
  try {
    j = JSON.parse(text)
  } catch (e) {
    throw new Error('拼多多返回异常（登录态可能已失效）')
  }
  if (j.error_code) {
    if (String(j.error_code) === '40001') throw new Error('拼多多登录态已失效，请重新登录网页版并更新 Cookie')
    throw new Error(`拼多多接口错误 ${j.error_code}：${j.error_msg || ''}`)
  }
  return j.orders || []
}

/**
 * 取件码查询。包裹已投放至自提柜/驿站时返回取件码，
 * 否则 code 为空（订单仍在途中）。
 * 注意：不能带 tracking_number / shipping_id / external 等参数，
 * 带了会走「外部来源」分支返回空结果，只能靠 order_sn 查。
 */
async function fetchPickupCode(cookie, order) {
  const url = `${BASE}/proxy/api/api/express/cabinet/${encodeURIComponent(order.order_sn)}`
  const r = await fetch(url, { headers: headers(cookie), signal: AbortSignal.timeout(TIMEOUT) })
  const text = await r.text()
  let j
  try {
    j = JSON.parse(text)
  } catch (e) {
    return { code: '', scanCode: false, status: -1 }
  }
  const result = j.result || {}
  return {
    code: typeof result.code === 'string' ? result.code.trim() : '',
    status: result.status,
    scanCode: !!(result.scanCodeInfo && result.scanCodeInfo.scanCode),
    address: result.address || '',
    company: result.companyName || '',
  }
}

/** 从订单对象里取商品名（首个商品） */
function goodsNameOf(order) {
  const g = (order.order_goods || [])[0]
  if (!g) return ''
  return g.goods_name || g.goods_title || ''
}

module.exports = { fetchOrders, fetchPickupCode, goodsNameOf, extractUid }
