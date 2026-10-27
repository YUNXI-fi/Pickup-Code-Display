require('dotenv').config()
const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const { init } = require('./db')
const setupRoutes = require('./routes/packages')
const setupExpressRoutes = require('./routes/express')
const setupPddRoutes = require('./routes/pdd')
const setupSettingsRoutes = require('./routes/settings')
const scheduler = require('./scheduler')

const app = express()
const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || '0.0.0.0'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const SESSION_DURATION_HOURS = parseInt(process.env.SESSION_DURATION_HOURS || '12', 10)

const GATEWAY_PREFIX = '/app/pickup-codes'

// x-strip gateway prefix so Express routes work regardless of access path
app.use((req, res, next) => {
  if (req.url.startsWith(GATEWAY_PREFIX)) {
    req.url = req.url.slice(GATEWAY_PREFIX.length) || '/'
  }
  next()
})

app.use(cors())
app.use(express.json({ limit: '20mb' }))

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) return next()
  const pw = req.headers['x-admin-password'] || req.query.pw
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).send(`
      <!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>登录</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <script>tailwind.config={theme:{extend:{colors:{primary:'#2563eb'}}}}</script>
      <style>input:focus{outline:none}input:-webkit-autofill{box-shadow:0 0 0 100px #fff inset}</style></head>
      <body class="bg-gradient-to-br from-blue-50 to-indigo-100 min-h-dvh flex items-center justify-center p-4">
      <div class="bg-white/80 backdrop-blur-sm rounded-2xl shadow-xl border border-white/60 w-full max-w-sm p-6 sm:p-8">
        <div class="text-center mb-6">
          <div class="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <svg class="w-7 h-7 text-primary" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>
          </div>
          <h1 class="text-xl font-bold text-gray-800">管理登录</h1>
          <p class="text-sm text-gray-400 mt-1">请输入密码以继续</p>
        </div>
        <p id="err" class="text-center text-red-500 text-sm mb-4 hidden bg-red-50 rounded-lg px-3 py-2">密码错误，请重试</p>
        <input id="pw" type="password" placeholder="管理密码" autocomplete="off"
          class="border border-gray-200 rounded-xl px-4 py-3 w-full mb-4 text-sm focus:ring-2 focus:ring-primary/30 focus:border-primary text-center text-lg tracking-widest placeholder:text-center placeholder:tracking-normal">
        <button onclick="login()" class="bg-primary text-white rounded-xl px-4 py-3 w-full hover:bg-blue-700 active:bg-blue-800 font-medium text-sm transition-all duration-150 shadow-sm shadow-primary/30">登 录</button>
      </div>
      <script>
        const SESSION_MS = ${SESSION_DURATION_HOURS} * 3600000
        ;(function() {
          try {
            var stored = JSON.parse(localStorage.getItem('admin_session') || '{}')
            if (stored.pw && stored.expiresAt > Date.now()) {
              window.location.href = window.location.pathname.split('?')[0] + '?pw=' + encodeURIComponent(stored.pw)
              return
            }
          } catch(e) {}
          localStorage.removeItem('admin_session')
        })()
        function login() {
          var pw = document.getElementById('pw').value
          if (!pw) return
          fetch('api/check-password', { headers: { 'x-admin-password': pw } })
            .then(function(r) {
              if (r.ok) {
                localStorage.setItem('admin_session', JSON.stringify({ pw: pw, expiresAt: Date.now() + SESSION_MS }))
                window.location.href = window.location.pathname.split('?')[0] + '?pw=' + encodeURIComponent(pw)
              } else {
                document.getElementById('err').classList.remove('hidden')
              }
            })
        }
        document.getElementById('pw').addEventListener('keydown', function(e) {
          if (e.key === 'Enter') login()
        })
      </script>
      </body></html>
    `)
  }
  next()
}

app.get('/admin.html', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
})
app.use(express.static(path.join(__dirname, 'public')))

// 动态数据接口不缓存：避免浏览器复用陈旧的快递列表
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  next()
})

setupRoutes(app)
setupExpressRoutes(app)
setupPddRoutes(app)
setupSettingsRoutes(app)

app.get('/api/check-password', (req, res) => {
  const pw = req.headers['x-admin-password']
  if (!ADMIN_PASSWORD || pw === ADMIN_PASSWORD) return res.json({ ok: true })
  res.status(401).json({ error: '密码错误' })
})

async function start() {
  await init()

  // fnOS 统一网关：监听 Unix Socket，不对外暴露端口
  const SOCKET_PATH = process.env.TRIM_APPDEST
    ? path.join(process.env.TRIM_APPDEST, 'app.sock')
    : null

  if (SOCKET_PATH) {
    try { fs.unlinkSync(SOCKET_PATH) } catch (e) {}
    app.listen(SOCKET_PATH, () => {
      console.log(`服务已启动 (Unix Socket): ${SOCKET_PATH}`)
    })
    scheduler.start()
    return
  }

  // 本地开发兜底：无 TRIM_APPDEST 时监听 TCP，便于本地预览调试
  app.listen(PORT, HOST, () => {
    console.log(`服务已启动: http://localhost:${PORT}`)
    console.log(`局域网访问: http://<本机IP>:${PORT}`)
  })
  scheduler.start()
}

start()
