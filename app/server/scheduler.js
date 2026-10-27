/**
 * 定时同步：按「设置 → 自动更新频率」定期拉取快递。
 *
 * 复用已有的同步接口（内部 HTTP 调用），保证与手动「更新快递」行为完全一致。
 * fnOS 下服务只监听 Unix Socket，因此这里同时支持 socketPath 与本地 TCP 两种方式。
 */
const http = require('http')
const path = require('path')
const { getDisplaySettings } = require('./settings')

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const PORT = process.env.PORT || 3000
const SOCKET_PATH = process.env.TRIM_APPDEST ? path.join(process.env.TRIM_APPDEST, 'app.sock') : null

let timer = null
let running = false

function selfCall(method, p) {
  return new Promise(resolve => {
    const opts = { method, path: p, headers: {} }
    if (SOCKET_PATH) opts.socketPath = SOCKET_PATH
    else { opts.host = '127.0.0.1'; opts.port = PORT }
    if (ADMIN_PASSWORD) opts.headers['x-admin-password'] = ADMIN_PASSWORD

    const req = http.request(opts, res => {
      let body = ''
      res.on('data', c => (body += c))
      res.on('end', () => resolve({ code: res.statusCode, body }))
    })
    req.on('error', e => resolve({ code: 0, body: e.message }))
    req.setTimeout(10 * 60 * 1000, () => { req.destroy(); resolve({ code: 0, body: 'timeout' }) })
    req.end()
  })
}

/** 执行一轮完整同步：淘宝同步 + 刷新取件码 + 拼多多同步 */
async function runOnce() {
  if (running) return
  running = true
  try {
    console.log('[scheduler] 开始定时同步')
    const a = await selfCall('POST', '/api/express/sync')
    const b = await selfCall('POST', '/api/express/fill-codes')
    const c = await selfCall('POST', '/api/pdd/sync')
    console.log(`[scheduler] 完成：taobao=${a.code} fill=${b.code} pdd=${c.code}`)
  } catch (e) {
    console.log('[scheduler] 异常：', e.message)
  } finally {
    running = false
  }
}

/** 按当前设置重新排定下一次执行 */
function schedule() {
  if (timer) clearTimeout(timer)
  const { syncInterval } = getDisplaySettings()
  console.log(`[scheduler] 下次同步将在 ${syncInterval} 分钟后`)
  timer = setTimeout(async () => {
    await runOnce()
    schedule()
  }, syncInterval * 60 * 1000)
  if (timer.unref) timer.unref() // 不阻止进程退出（HTTP 服务本身会保持进程存活）
}

module.exports = { start: schedule, restart: schedule, runOnce }
