const crypto = require('crypto')

const APPKEY = '12574478'
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Mobile Safari/537.36'
const TIMEOUT = 20000

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex')
}

/** 设置 cookie 值：存在则替换，不存在则追加 */
function setCookieValue(cookieStr, name, value) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|;\\s*)${safe}=[^;]*`)
  if (re.test(cookieStr)) return cookieStr.replace(re, `$1${name}=${value}`)
  return cookieStr ? `${cookieStr}; ${name}=${value}` : `${name}=${value}`
}

/** 累积响应里的 Set-Cookie（跳过空值），返回新的 cookie 串 */
function accumulateCookies(cookieStr, headers) {
  const list = headers.getSetCookie ? headers.getSetCookie() : []
  let out = cookieStr
  for (const raw of list) {
    const first = raw.split(';')[0]
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (!name || value === '') continue
    out = setCookieValue(out, name, value)
  }
  return out
}

/** mtop 通用调用：先刷 _m_h5_tk token，再算 wapSign。opts:{method:'GET'|'POST',json:boolean} */
async function mtopCall(cookies, api, v, dataObj, host, opts = {}) {
  const base = `https://${host}/h5/${api}/${v}/`
  const headers = {
    'User-Agent': UA,
    Origin: 'https://h5.m.taobao.com',
    Referer: 'https://h5.m.taobao.com/',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Cookie: cookies,
  }

  let ck = cookies
  try {
    const resp = await fetch(`${base}?appKey=${APPKEY}`, { headers, signal: AbortSignal.timeout(TIMEOUT) })
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : []
    const raw = setCookies.join('\n')
    const tk = raw.match(/_m_h5_tk=([^;]+)/)
    const enc = raw.match(/_m_h5_tk_enc=([^;]+)/)
    // 扫码登录拿到的 Cookie 不含 _m_h5_tk，此时要「追加」而非「替换」（replace 无匹配会静默失败）
    if (tk) ck = setCookieValue(ck, '_m_h5_tk', tk[1])
    if (enc) ck = setCookieValue(ck, '_m_h5_tk_enc', enc[1])
  } catch (e) {
    // 刷 token 失败不致命，继续用现有 cookie 里的 token
  }

  const tokenMatch = ck.match(/_m_h5_tk=([^;]+)/)
  if (!tokenMatch) throw new Error('缺少 _m_h5_tk cookie，请重新登录淘宝')
  const token = tokenMatch[1].split('_')[0]
  const t = Date.now().toString()
  const dataRaw = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj)
  const sign = md5(`${token}&${t}&${APPKEY}&${dataRaw}`)

  let resp
  if (opts.method === 'POST') {
    // PC 端接口（type=originaljson）：data 放 body，可拿到含取件码的完整 cell 树；
    // 必须带 ttid=201200@taobao_iphone_99.99.99，否则报「服务内部故障」
    const url = `${base}?jsv=2.7.2&appKey=${APPKEY}&t=${t}&sign=${sign}&v=${v}&ecode=1&timeout=8000&dataType=json&valueType=original&ttid=201200%40taobao_iphone_99.99.99&needLogin=true&type=originaljson&isHttps=1&needRetry=true&api=${api}&preventFallback=true`
    resp = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Cookie: ck, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(dataRaw),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } else {
    const url = `${base}?jsv=2.3.18&appKey=${APPKEY}&t=${t}&sign=${sign}&type=jsonp&dataType=jsonp&data=${encodeURIComponent(dataRaw)}`
    resp = await fetch(url, { headers: { ...headers, Cookie: ck }, signal: AbortSignal.timeout(TIMEOUT) })
  }
  const text = await resp.text()

  let json = text
  if (!opts.json) {
    const lb = text.indexOf('(')
    const rb = text.lastIndexOf(')')
    if (lb >= 0 && rb > lb) json = text.slice(lb + 1, rb)
  }

  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new Error('mtop 返回解析失败：' + text.slice(0, 120))
  }
  const ret = parsed.ret || parsed.retCode || []
  const flat = Array.isArray(ret) ? ret.join(' ') : String(ret)
  if (ret.includes('FAIL_SYS_TOKEN_EXOIRED') || ret.includes('FAIL_SYS_TOKEN_EXPIRED')) {
    throw new Error('淘宝登录态已失效，请重新粘贴 Cookie')
  }
  // 实测：Cookie 失效时 mtop 不报 token 错误，而是返回 data:{} + SESSION_EXPIRED；
  // 若不拦截，fetchOrders 会静默返回空列表，用户会误以为「没有在途快递」。
  if (flat.includes('SESSION_EXPIRED') || flat.includes('ILLEGAL_ACCESS')) {
    throw new Error(flat.includes('ILLEGAL_ACCESS')
      ? '淘宝接口拒绝访问（IP 风控），稍后再试'
      : '淘宝登录态已失效，请重新粘贴 Cookie')
  }
  return parsed
}

/** 订单列表 → [{orderId, tradeStatus, statusText, goodsName}] */
async function fetchOrders(cookies, page = 1) {
  const dataObj = {
    tabCode: 'all',
    page: String(page),
    orderType: 'OrderList',
    templateConfigVersion: '0',
    appName: 'tborder',
    appVersion: '3.0',
    condition: '{"version":"1.0.0","appChannel":""}',
    ttid: '201200@taobao_h5_9.18.0',
    requestIdentity: '#t#ip#h5',
  }
  const parsed = await mtopCall(cookies, 'mtop.taobao.order.queryboughtlistv2', '1.0', dataObj, 'h5api.m.taobao.com')
  const data = parsed.data
  if (!data || Object.keys(data).length === 0) {
    throw new Error('淘宝未返回订单数据，Cookie 可能已失效，请重新粘贴')
  }

  let inner = null
  try {
    inner = typeof data.result === 'string' ? JSON.parse(data.result) : data.result
  } catch (e) {
    inner = null
  }
  if (!inner) inner = data.data || null
  if (!inner) return []

  const mainOrders = inner.mainOrders
  if (!Array.isArray(mainOrders)) return []

  return mainOrders.map(o => {
    const item = o.subOrders && o.subOrders[0] && o.subOrders[0].itemInfo
    return {
      orderId: o.id,
      tradeStatus: (o.extra && o.extra.tradeStatus) || '',
      statusText: (o.statusInfo && o.statusInfo.text) || '',
      goodsName: (item && item.title) || '',
    }
  })
}

/** 从 `marker` 处开始截取一个完整 JSON 对象（括号配对，跳过字符串内的括号） */
function sliceJsonObject(text, start) {
  let depth = 0
  let inStr = false
  let quote = ''
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return ''
}

/**
 * 代收/代签（非本人签收）的文案特征：命中即视为「待取件」，而不是「已完成」。
 * 覆盖：自提柜/驿站，以及前台/门卫/门口等代签。
 */
const PICKUP_POINT_HINTS = [
  '自提柜', '快递柜', '驿站', '代收点', '代收', '凭取货码', '请及时取件', '已存放至',
  '前台', '门卫', '门口', '门房', '保安', '物业', '代签',
]

/** 快递公司编码 → 中文名（拆单/多包裹订单只给 cpCode，无公司名） */
const CP_CODE_NAMES = {
  YTO: '圆通速递', ZTO: '中通快递', STO: '申通快递', YUNDA: '韵达速递',
  SF: '顺丰速运', EMS: 'EMS', JD: '京东物流', JTSD: '极兔速递',
  HTKY: '百世快递', BEST: '百世快递', YZPY: '邮政快递包裹', YZGN: '邮政国内',
  UC: '优速快递', DBL: '德邦快递', ANE: '安能物流', GTO: '国通快递',
}

/**
 * SSR 物流页 → 包裹信息（免签名）。
 * 取件码/驿站优先取 multiStage[].cardDesc 结构化字段；该字段在部分版本已缺失，
 * 此时驿站名回退到从物流文案提取（如「您的快件已存放至 xxx 丰巢柜」）。
 */
async function fetchParcel(cookies, orderId) {
  const url = `https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail?x-ssr=true&bizOrderId=${orderId}`
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Cookie: cookies,
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const html = await resp.text()

  const marker = "__ICE_SUSPENSE_LOADER__']['undefined'] = "
  const i = html.indexOf(marker)
  if (i < 0) return null

  let fields
  try {
    const raw = sliceJsonObject(html, i + marker.length)
    const obj = JSON.parse(raw)
    const d = obj.result && obj.result.data
    const lg = (d && (d.newLogistics || d.logisticsDetailH5)) || null
    fields = lg && lg.fields
  } catch (e) {
    return null
  }
  if (!fields) return null

  const company = fields.logisticCompany || {}
  let mailNo = fields.mailNo || company.mailNo || ''
  let cpName = company.name || ''

  // 拆单/多包裹订单：无 mailNo 与 logisticCompany，运单号在 multiPackages.packages[].mailNo
  if (!mailNo && fields.multiPackages) {
    const pkgs = Array.isArray(fields.multiPackages.packages) ? fields.multiPackages.packages : []
    const mp = pkgs.find(x => x && x.mailNo)
    if (mp) {
      mailNo = mp.mailNo
      cpName = cpName || CP_CODE_NAMES[mp.cpCode] || mp.cpCode || ''
    }
  }

  if (!mailNo) return null

  const stages = Array.isArray(fields.multiStage) ? fields.multiStage : []
  let stateLabel = ''
  let latestText = ''
  let pickupCode = ''
  let hintText = ''
  let station = ''
  let address = ''
  let recipient = ''
  let phone = ''
  let atPickupPoint = false

  for (const s of stages) {
    const ld = s.labelDesc || {}
    let text = ''
    if (Array.isArray(ld.richContent)) text = ld.richContent.map(r => r.text || '').join('')
    else if (typeof ld === 'string') text = ld
    else text = ld.text || s.text || ''

    if (!stateLabel) stateLabel = s.title || ''
    if (!latestText) latestText = text
    hintText += ' ' + (s.title || '') + ' ' + text

    const card = s.cardDesc || {}
    const ec = (card.custom && card.custom.expressCode) || null
    if (!pickupCode && ec && ec.code) pickupCode = String(ec.code).trim()
    if (!station) {
      // cardDesc 结构在部分版本已缺失，驿站名回退到从物流文案提取
      if (card.title) station = String(card.title).trim()
      else { const st = extractStation(text); if (st) station = st }
    }
    if (!address && card.subTitle) address = String(card.subTitle).trim()

    // 已到达自提柜/驿站等待取件：丰巢等「已签收」实为柜子代签（签收人凭取货码签收），
    // 标题出现「待取件」或文案含取件提示都算到达驿站
    if (!atPickupPoint && (s.title === '待取件' || PICKUP_POINT_HINTS.some(h => text.includes(h)))) {
      atPickupPoint = true
    }

    // 兜底：个别驿站不给结构化字段，只在文案里写取件码
    if (!pickupCode && text) {
      const m = text.match(/(?:取件码|取货码|提货码|自提码)\s*(?:是|为|码)?\s*[:：\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,11})/)
      if (m) pickupCode = m[1]
    }

    // 送达节点：title「送至 xx」，labelDesc.text「收件人 86-187****6492」
    // （开通号码保护时手机号打码，但尾号 4 位仍可读）
    if (!recipient && typeof s.title === 'string' && s.title.startsWith('送至')) {
      const rc = parseRecipient(text)
      recipient = rc.recipient
      phone = rc.phone
    }
  }

  // 拆单/多包裹订单：h5-detail 常只给「已发货，暂无物流信息」，真实轨迹在 transit_step，
  // 用它补充「待取件」判定与驿站名（该接口响应为 GBK）
  if (fields.multiPackages && mailNo) {
    try {
      const t = await fetchTransitSteps(cookies, orderId)
      const latest = (t.steps[0] && t.steps[0].place) || ''
      if (latest && (!latestText || latestText.includes('暂无物流信息'))) latestText = latest
      if (!atPickupPoint && PICKUP_POINT_HINTS.some(h => latest.includes(h))) atPickupPoint = true
      if (!station) { const st = extractStation(latest); if (st) station = st }
      if (!cpName && t.expressName) cpName = t.expressName
    } catch (e) { /* 轨迹补充失败不影响主流程 */ }
  }

  // 自提柜/驿站：最新节点为「已签收」，且轨迹里更早出现过「待取件/已存放至」等入柜节点
  // → 说明是入柜之后凭取货码取走，属于已取件。
  // 只有「已签收」而没有入柜节点的，仍按柜机代签处理，避免把刚入柜的件误判为已取。
  const picked = stateLabel.includes('签收') && /待取件|已存放至|存放至|请及时取件/.test(hintText)

  return {
    mailNo,
    cpName,
    stateLabel,
    latestText,
    hintText,
    picked,
    pickupCode,
    station: station || address,
    address,
    recipient,
    phone,
    atPickupPoint,
  }
}

/** 从物流文案提取驿站/代收点名称（cardDesc 结构失效后的兜底） */
function extractStation(text) {
  if (!text) return ''
  let m = text.match(/(?:存放至|已到达|存入)([^，,。【]+)/)
  if (m && m[1]) return m[1].trim()
  // 代签写法：「您的快件已由【前台】签收」→ 取「前台」
  m = text.match(/由【(.+?)】/)
  return m && m[1] ? m[1].trim() : ''
}

/**
 * 物流轨迹（PC 接口 transit_step）：拆单/多包裹订单的 h5-detail 常不含轨迹，用它补充。
 * 返回 { expressName, expressId, steps: [{place, time}] }；响应为 GBK 编码，需按 gbk 解码。
 */
async function fetchTransitSteps(cookies, orderId) {
  const url = `https://buyertrade.taobao.com/trade/json/transit_step.do?bizOrderId=${orderId}`
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://buyertrade.taobao.com/',
      Cookie: cookies,
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const buf = Buffer.from(await resp.arrayBuffer())
  let text
  try { text = new TextDecoder('gbk').decode(buf) } catch (e) { text = buf.toString('utf8') }
  const data = JSON.parse(text)
  return {
    expressName: data.expressName || '',
    expressId: data.expressId || '',
    steps: Array.isArray(data.address) ? data.address : [],
  }
}

/**
 * 待收货订单的取件码（PC 端 queryboughtlistV2，POST + originaljson）。
 * 取件码在 data.data.comServiceTips_<orderId>.fields.singleLineRiceText[].richStr 里
 * （形如「取件码 83993005」），待收货列表一个请求即可覆盖全部。
 * 返回 { orderId: pickupCode }；失败返回 {}（取件码缺失不影响主流程）。
 */
async function fetchPickupCodes(cookies) {
  try {
    const dataObj = {
      tabCode: 'waitConfirm',
      appVersion: '3.0',
      OrderType: 'OrderList',
      condition: { inner: 1, deviceLevel: 'high', version: '1.0.0', reqFrom: 'tbpc' },
      appName: 'tborder',
      templateConfigVersion: 0,
      forceBoughtlist4: 4,
      page: '1',
    }
    const parsed = await mtopCall(cookies, 'mtop.taobao.order.queryboughtlistV2', '1.0', dataObj, 'h5api.m.taobao.com', { method: 'POST', json: true })
    const cells = (parsed.data && parsed.data.data) || {}
    const map = {}
    for (const key of Object.keys(cells)) {
      const cell = cells[key]
      if (!key.startsWith('comServiceTips_') || !cell || !cell.fields) continue
      const richText = Array.isArray(cell.fields.singleLineRiceText) ? cell.fields.singleLineRiceText : []
      const text = richText.map(x => x && x.richStr || '').join(' ')
      const m = text.match(/取件码\s*[:：]?\s*([A-Za-z0-9-]+)/)
      if (m) map[cell.id || key.slice('comServiceTips_'.length)] = m[1]
    }
    return map
  } catch (e) {
    return {}
  }
}

/** 解析「收件人 86-187****6492」，返回 {recipient, phone: 尾号4位} */
function parseRecipient(text) {
  const t = (text || '').trim()
  if (!t) return { recipient: '', phone: '' }
  const masked = t.match(/^(.*?)\s*(?:\d{2,3}-)?\d{3}\*{4}(\d{4})$/)
  if (masked) return { recipient: masked[1].trim(), phone: masked[2] }
  const plain = t.match(/^(.*?)\s*(?:\d{2,3}-)?(\d{3})\d{4}(\d{4})$/)
  if (plain) return { recipient: plain[1].trim(), phone: plain[3] }
  return { recipient: t, phone: '' }
}

module.exports = { fetchOrders, fetchParcel, fetchPickupCodes, accumulateCookies, setCookieValue }