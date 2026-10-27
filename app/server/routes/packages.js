const { Router } = require('express')
const { stmts } = require('../db')
const { broadcast, addClient } = require('../sse')
const settings = require('../settings')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY || ''
const SILICONFLOW_MODEL = process.env.SILICONFLOW_MODEL || 'Pro/Qwen-VL-Chat-7B'

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  const pw = req.headers['x-admin-password']
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授权' })
  next()
}

module.exports = function (app) {
  const router = Router()

  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write(':\n\n')
    addClient(res)
  })

  router.get('/packages', (req, res) => {
    const { status } = req.query
    const rows = status ? stmts.all.all() : stmts.pending.all()
    // 「代取快递」被隐藏时不下发（数据仍保留在库中）
    const { showProxy, keywords } = settings.getDisplaySettings()
    res.json(showProxy ? rows : rows.filter(r => !settings.isProxyRow(r, keywords)))
  })

  router.get('/history', (req, res) => {
    const { field } = req.query
    const valid = { recipient: 'historyRecipient', phone: 'historyPhone', address: 'historyAddress' }
    if (!valid[field]) return res.status(400).json({ error: 'invalid field' })
    res.json(stmts[valid[field]].all())
  })

  router.post('/packages', requireAuth, (req, res) => {
    const { pickup_code, company, recipient, phone, address } = req.body
    if (!pickup_code) return res.status(400).json({ error: '取件码不能为空' })
    const info = stmts.insert.run({ pickup_code, company, recipient, phone, address })
    const row = stmts.getById.get(info.lastInsertRowid)
    broadcast('create', row)
    res.status(201).json(row)
  })

  router.patch('/packages/:id/pickup', (req, res) => {
    const { id } = req.params
    const info = stmts.pickup.run(id)
    if (info.changes === 0) return res.status(404).json({ error: '包裹不存在或已被取走' })
    const row = stmts.getById.get(id)
    broadcast('update', row)
    res.json(row)
  })

  /** 撤回取件：展示页的「撤回」与后台共用。取件接口本身不鉴权，撤回保持一致 */
  router.patch('/packages/:id/restore', (req, res) => {
    const { id } = req.params
    const info = stmts.restore.run(id)
    if (info.changes === 0) return res.status(404).json({ error: '包裹不存在或未取件' })
    const row = stmts.getById.get(id)
    broadcast('update', row)
    res.json(row)
  })

  /** 编辑包裹：全量覆盖字段，空值即清空（区别于同步接口的「非空才覆盖」） */
  router.patch('/packages/:id', requireAuth, (req, res) => {
    const { id } = req.params
    const { pickup_code, company, recipient, phone, address } = req.body
    if (!pickup_code || !String(pickup_code).trim()) {
      return res.status(400).json({ error: '取件码不能为空' })
    }
    if (!stmts.getById.get(id)) return res.status(404).json({ error: '包裹不存在' })

    stmts.updatePackage.run({
      id,
      pickup_code: String(pickup_code).trim(),
      company,
      recipient,
      phone,
      address,
    })
    const row = stmts.getById.get(id)
    broadcast('update', row)
    res.json(row)
  })

  router.delete('/packages/:id', requireAuth, (req, res) => {
    const { id } = req.params
    const row = stmts.getById.get(id)
    if (!row) return res.status(404).json({ error: '包裹不存在' })
    stmts.remove.run(id)
    broadcast('delete', row)
    res.json({ ok: true })
  })

  router.post('/recognize', requireAuth, async (req, res) => {
    if (!SILICONFLOW_API_KEY || SILICONFLOW_API_KEY === 'sk-your-key-here') {
      return res.status(400).json({ error: '请先在应用设置中配置 SiliconFlow API Key' })
    }
    const { image, mime_type } = req.body
    if (!image) return res.status(400).json({ error: '缺少图片数据' })

    const body = {
      model: SILICONFLOW_MODEL,
      enable_thinking: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime_type || 'image/jpeg'};base64,${image}` } },
          { type: 'text', text: '识别这张快递面单图片，提取所有包裹的取件码、快递公司和取件地址。取件地址通常是驿站名称或代收点名称（如"菜鸟驿站"、"妈妈驿站"、"兔喜快递超市"等），也可以从收件地址中提取。如果面单上没有明确的取件地址，尝试从收件地址中提取驿站/代收点信息。只返回JSON数组，格式: [{"pickup_code":"取件码","company":"快递公司","address":"取件地址"}]，不要其他文字。' },
        ],
      }],
    }

    try {
      const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SILICONFLOW_API_KEY}`,
        },
        body: JSON.stringify(body),
      })
      if (!resp.ok) {
        const err = await resp.text()
        return res.status(502).json({ error: 'AI识别请求失败', detail: err })
      }
      const data = await resp.json()
      const text = data.choices?.[0]?.message?.content || ''
      let packages = []
      try {
        packages = JSON.parse(text)
      } catch {
        const match = text.match(/\[[\s\S]*?\]/)
        if (match) packages = JSON.parse(match[0])
      }
      res.json({ packages })
    } catch (e) {
      res.status(502).json({ error: 'AI识别请求异常: ' + e.message })
    }
  })

  app.use('/api', router)
}
