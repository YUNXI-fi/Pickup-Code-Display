const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the merged routes against an isolated database, without real accounts.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup-merge-test-'))
process.env.TRIM_PKGVAR = dataDir
process.env.ADMIN_PASSWORD = ''
const { init, stmts, getDb } = require('../db')
const accounts = require('../accounts')
const pdd = require('../pdd')
const express = require('express')
const setupPdd = require('../routes/pdd')
let server
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  if (getDb()) getDb().close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('merged PDD sync preserves multi-account imports, status progression and completion filtering', async () => {
  await init()
  for (const id of ['one', 'two']) accounts.save('pdd', { id, name: id, cookie: id })
  const old = stmts.insertExpress.run({ order_id: 'done', mail_no: 'done-mail', source_platform: 'pdd', status: 'shipping' })
  for (let i = 0; i < 2; i++) stmts.insertExpress.run({ order_id: 'ship', mail_no: 'ship-mail', source_platform: 'pdd', status: 'shipping' })
  let delivered = false
  const calls = []
  pdd.fetchOrders = async cookie => {
    calls.push(cookie)
    if (cookie === 'two') return [{ order_sn: 'second', order_status_prompt: '待发货', status: 2, shipping_status: 0 }]
    return [
      { order_sn: 'wait', order_status_prompt: '拼单成功，待发货', status: 2, shipping_status: 0 },
      { order_sn: 'ship', tracking_number: 'ship-mail', order_status_prompt: '待收货', status: 3, shipping_status: 1 },
      { order_sn: 'pick', tracking_number: 'pick-mail', order_status_prompt: '待收货', status: 3, shipping_status: 1 },
      { order_sn: 'done', tracking_number: 'done-mail', order_status_prompt: '已签收，待确认收货', status: 3, shipping_status: 1 },
      { order_sn: 'review', tracking_number: 'review-mail', order_status_prompt: '待评价', status: 4, shipping_status: 2 },
      { order_sn: 'unpaid', order_status_prompt: '待付款', status: 1 },
    ]
  }
  pdd.fetchPickupCode = async (cookie, order) => {
    assert.equal(cookie, 'one')
    return { code: order.order_sn === 'pick' || delivered ? 'TEST-CODE' : '' }
  }
  const app = express()
  app.use(express.json())
  setupPdd(app)
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const url = `http://127.0.0.1:${server.address().port}/api/pdd/sync`
  const sync = async () => {
    const response = await fetch(url, { method: 'POST' })
    assert.equal(response.status, 200)
    return response.json()
  }
  await sync()
  assert.deepEqual(calls, ['one', 'two'])
  assert.equal(stmts.getByOrderId.get('wait').status, 'to_ship')
  assert.equal(stmts.getByOrderId.get('second').status, 'to_ship')
  assert.equal(stmts.getByOrderId.get('ship').status, 'shipping')
  assert.equal(stmts.getByOrderId.get('pick').status, 'pending')
  assert.equal(stmts.getById.get(old.lastInsertRowid), undefined)
  assert.equal(stmts.getByOrderId.get('review'), undefined)
  assert.equal(stmts.getByOrderId.get('unpaid'), undefined)
  assert.equal(stmts.all.all().filter(row => row.order_id === 'ship').length, 1)
  assert.ok(stmts.all.all().every(row => row.source_platform === 'pdd'))
  const repeated = await sync()
  assert.equal(repeated.created.length, 0)
  delivered = true
  await sync()
  assert.equal(stmts.getByOrderId.get('ship').status, 'pending')
  stmts.pickup.run(stmts.getByOrderId.get('pick').id)
  await sync()
  assert.equal(stmts.getByOrderId.get('pick').status, 'picked_up')
})

const adminSource = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8')
const refreshSource = adminSource.slice(adminSource.indexOf('async function refreshPackages()'), adminSource.indexOf("refreshBtn.addEventListener('click', refreshPackages)"))
for (const scenario of ['none', 'pdd-only', 'taobao-only', 'taobao-fails']) {
  test(`refresh handles ${scenario}`, async () => {
    const calls = []
    const messages = []
    const context = {
      refreshBtn: { disabled: false, classList: { add() {}, remove() {} }, querySelector: () => ({ classList: { add() {}, remove() {} } }) },
      showStatus: (text, ok) => messages.push({ text, ok }),
      loadAll() {},
      authFetch: async url => {
        calls.push(url)
        if (url.endsWith('/status')) return { json: async () => ({ cookie_set: url.includes('/pdd/') ? ['pdd-only', 'taobao-fails'].includes(scenario) : ['taobao-only', 'taobao-fails'].includes(scenario) }) }
        const ok = !(scenario === 'taobao-fails' && url === 'api/express/sync')
        return { ok, json: async () => ({ created: [], filled: [], error: ok ? undefined : 'test failure' }) }
      },
    }
    vm.createContext(context)
    await vm.runInContext(refreshSource + '\nrefreshPackages()', context)
    const syncCalls = calls.filter(url => !url.endsWith('/status'))
    const expected = {
      none: [],
      'pdd-only': ['api/pdd/sync'],
      'taobao-only': ['api/express/sync', 'api/express/fill-codes'],
      'taobao-fails': ['api/express/sync', 'api/pdd/sync'],
    }[scenario]
    assert.deepEqual(syncCalls, expected)
    assert.equal(context.refreshBtn.disabled, false)
    if (scenario === 'taobao-fails') {
      assert.match(messages.at(-1).text, /淘宝刷新失败.*拼多多新增/)
      assert.equal(messages.at(-1).ok, false)
    }
  })
}

test('display page has a relative admin entry for local and fnOS gateway paths', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.match(html, /href="admin\.html"[^>]*>管理<\/a>/)
  assert.equal(new URL('admin.html', 'http://localhost:3000/').pathname, '/admin.html')
  assert.equal(new URL('admin.html', 'http://localhost:3000/app/pickup-codes/').pathname, '/app/pickup-codes/admin.html')
})
