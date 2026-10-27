const { Router } = require('express')
const settings = require('../settings')
const scheduler = require('../scheduler')
const pkg = require('../package.json')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

function requireAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: '未授权' })
  next()
}

module.exports = function (app) {
  const router = Router()

  /** 展示设置 + 版本号 */
  router.get('/settings', requireAuth, (req, res) => {
    const { showProxy, keywords, syncInterval } = settings.getDisplaySettings()
    res.json({
      show_proxy: showProxy,
      proxy_keywords: keywords.join(','),
      proxy_keywords_default: settings.DEFAULT_PROXY_KEYWORDS.join(','),
      sync_interval: syncInterval,
      sync_intervals: settings.SYNC_INTERVALS,
      version: pkg.version,
    })
  })

  /** 只保存传入的字段，未传的保持不变 */
  router.put('/settings', requireAuth, (req, res) => {
    const { show_proxy, proxy_keywords, sync_interval } = req.body || {}
    settings.saveDisplaySettings({
      showProxy: typeof show_proxy === 'boolean' ? show_proxy : undefined,
      keywords: typeof proxy_keywords === 'string' ? proxy_keywords : undefined,
      syncInterval: sync_interval === undefined ? undefined : Number(sync_interval),
    })
    // 频率变了才需要重排定时器
    if (sync_interval !== undefined) scheduler.restart()
    res.json({ ok: true })
  })

  app.use('/api', router)
}
