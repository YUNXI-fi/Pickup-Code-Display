const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')

const DB_PATH = process.env.TRIM_PKGVAR ? path.join(process.env.TRIM_PKGVAR, 'data.db') : path.join(__dirname, 'data.db')
let db = null

function save() {
  if (!db) return
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()))
}

function fixBind(params) {
  if (!params) return params
  // 数组参数必须原样绑定。此前把「纯数字字符串」强转成 Number，会导致：
  // ① TEXT 列（mail_no）等值查询类型不匹配 → 去重失效、同一包裹重复导入
  // ② 前导零被吃掉（'061365' → 61365）→ 单号永久查不到
  // 整型 id 列用字符串比较时 SQLite 会自动套用 NUMERIC 亲和性，无需强转。
  if (Array.isArray(params)) return params
  const out = {}
  for (const key of Object.keys(params)) {
    const k = key.startsWith('@') || key.startsWith(':') || key.startsWith('$') ? key : '@' + key
    out[k] = params[key] === undefined ? null : params[key]
  }
  return out
}

function prepare(sql) {
  const stmt = db.prepare(sql)
  return {
    all(params) {
      stmt.bind(fixBind(params))
      const rows = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      stmt.free()
      return rows
    },
    get(params) {
      stmt.bind(fixBind(params))
      const row = stmt.step() ? stmt.getAsObject() : undefined
      stmt.free()
      return row
    },
    run(params) {
      stmt.bind(fixBind(params))
      stmt.step()
      const rowId = db.exec("SELECT last_insert_rowid()")[0].values[0][0]
      const ch = db.exec("SELECT changes()")[0].values[0][0]
      stmt.free()
      save()
      return { lastInsertRowid: rowId, changes: ch }
    },
  }
}

async function init() {
  const SQL = await initSqlJs()
  const exists = fs.existsSync(DB_PATH)
  db = exists ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database()
  db.run(`CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pickup_code TEXT NOT NULL,
    recipient TEXT,
    phone TEXT,
    address TEXT,
    company TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('to_ship','shipping','pending','picked_up','expired')),
    created_at TEXT DEFAULT (datetime('now','localtime')),
    picked_up_at TEXT,
    mail_no TEXT,
    order_id TEXT,
    goods_name TEXT,
    proxy INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`)
  // 兼容旧库：补齐历史版本缺失的列（新库已全部包含，ALTER 会抛错并被忽略）
  try { db.run("ALTER TABLE packages ADD COLUMN company TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN address TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN mail_no TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN order_id TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN goods_name TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN account_id INTEGER") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN proxy INTEGER DEFAULT 0") } catch (_) {}

  // 旧库的 status CHECK 约束不含 to_ship/shipping，SQLite 无法直接修改约束 → 重建表迁移
  const tinfo = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='packages'")
  const tableSql = (tinfo[0] && tinfo[0].values[0] && tinfo[0].values[0][0]) || ''
  if (!tableSql.includes("'to_ship'")) {
    db.run('ALTER TABLE packages RENAME TO packages_old')
    db.run(`CREATE TABLE packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pickup_code TEXT NOT NULL,
      recipient TEXT,
      phone TEXT,
      address TEXT,
      company TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('to_ship','shipping','pending','picked_up','expired')),
      created_at TEXT DEFAULT (datetime('now','localtime')),
      picked_up_at TEXT,
      mail_no TEXT,
      order_id TEXT,
      goods_name TEXT,
      proxy INTEGER DEFAULT 0
    )`)
    db.run(`INSERT INTO packages (id, pickup_code, recipient, phone, address, company, status, created_at, picked_up_at, mail_no, order_id, goods_name)
            SELECT id, pickup_code, recipient, phone, address, company, status, created_at, picked_up_at, mail_no, order_id, goods_name FROM packages_old`)
    db.run('DROP TABLE packages_old')
  }
  // 更新时间：记录最后一次被同步/编辑/取件改动的时间，旧数据回退到已取件时间或录入时间
  try { db.run("ALTER TABLE packages ADD COLUMN updated_at TEXT") } catch (_) {}
  db.run("UPDATE packages SET updated_at = COALESCE(picked_up_at, created_at) WHERE updated_at IS NULL")
  try { db.run("CREATE INDEX IF NOT EXISTS idx_packages_mail_no ON packages(mail_no)") } catch (_) {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_packages_order_id ON packages(order_id)") } catch (_) {}
  db.run(`CREATE TABLE IF NOT EXISTS express_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`)
  db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')
  // 多账号：每个平台（taobao / pdd）可保存多个登录账号
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    remark TEXT,
    cookie TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    last_sync_at TEXT,
    last_sync_status TEXT,
    last_sync_detail TEXT
  )`)
  // 兼容旧库：补齐账号同步状态列
  try { db.run("ALTER TABLE accounts ADD COLUMN last_sync_at TEXT") } catch (_) {}
  try { db.run("ALTER TABLE accounts ADD COLUMN last_sync_status TEXT") } catch (_) {}
  try { db.run("ALTER TABLE accounts ADD COLUMN last_sync_detail TEXT") } catch (_) {}
  migrateLegacyAccounts()
  backfillAccountSyncStatus()
  save()
}

/** 把旧版「单账号」设置（settings 表）迁移进 accounts 表，幂等 */
function migrateLegacyAccounts() {
  const legacy = [
    { platform: 'taobao', cookieKey: 'taobao_cookie', remarkKey: 'taobao_remark' },
    { platform: 'pdd', cookieKey: 'pdd_cookie', remarkKey: 'pdd_remark' },
  ]
  for (const l of legacy) {
    try {
      const n = db.exec('SELECT COUNT(*) FROM accounts WHERE platform = ?', [l.platform])[0].values[0][0]
      if (n > 0) continue
      const c = db.exec('SELECT value FROM settings WHERE key = ?', [l.cookieKey])
      const cookie = c[0] && c[0].values[0] ? c[0].values[0][0] : ''
      if (!cookie) continue
      const r = db.exec('SELECT value FROM settings WHERE key = ?', [l.remarkKey])
      const remark = r[0] && r[0].values[0] ? r[0].values[0][0] : null
      db.run('INSERT INTO accounts (platform, remark, cookie) VALUES (?, ?, ?)', [l.platform, remark, cookie])
      db.run('DELETE FROM settings WHERE key = ?', [l.cookieKey])
      db.run('DELETE FROM settings WHERE key = ?', [l.remarkKey])
    } catch (_) {}
  }
}

/**
 * 账号状态回填：新列刚引入时，用该平台最近一次同步结果初始化。
 * 只处理 last_sync_status 为空的行，之后由同步流程按账号维护。
 */
function backfillAccountSyncStatus() {
  try {
    const pending = db.exec('SELECT id, platform FROM accounts WHERE last_sync_status IS NULL')
    if (!pending[0]) return
    const byPlatform = {}
    for (const [id, platform] of pending[0].values) {
      if (!(platform in byPlatform)) {
        const r = db.exec('SELECT status, detail, created_at FROM express_sync_log WHERE source = ? ORDER BY id DESC LIMIT 1', [platform])
        byPlatform[platform] = r[0] && r[0].values[0] ? r[0].values[0] : null
      }
      const last = byPlatform[platform]
      if (!last) continue
      db.run('UPDATE accounts SET last_sync_status = ?, last_sync_detail = ?, last_sync_at = ? WHERE id = ?',
        [last[0], last[1], last[2], id])
    }
  } catch (_) {}
}

function getDb() { return db }

const stmts = {
  // 列表按「待取件 → 运输中 → 待发货 → 已取件」展示，同状态内按创建时间倒序
  all: {
    all: () => prepare(`
      SELECT * FROM packages
      ORDER BY CASE status
        WHEN 'pending' THEN 0
        WHEN 'shipping' THEN 1
        WHEN 'to_ship' THEN 2
        WHEN 'picked_up' THEN 3
        ELSE 4
      END, created_at DESC
    `).all(),
  },
  pending: { all: () => prepare("SELECT * FROM packages WHERE status = 'pending' ORDER BY created_at DESC").all() },
  getById: { get: (id) => prepare('SELECT * FROM packages WHERE id = ?').get([id]) },
  insert: { run: (p) => prepare('INSERT INTO packages (pickup_code, company, recipient, phone, address) VALUES (@pickup_code, @company, @recipient, @phone, @address)').run({ pickup_code: p.pickup_code, company: p.company || null, recipient: p.recipient || null, phone: p.phone || null, address: p.address || null }) },
  pickup: { run: (id) => prepare("UPDATE packages SET status = 'picked_up', picked_up_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'").run([id]) },
  /** 同步侧标记已取件：任意未取件状态都可推进 */
  markPicked: { run: (id) => prepare("UPDATE packages SET status = 'picked_up', picked_up_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ? AND status != 'picked_up'").run([id]) },
  remove: { run: (id) => prepare('DELETE FROM packages WHERE id = ?').run([id]) },
  restore: { run: (id) => prepare("UPDATE packages SET status = 'pending', picked_up_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'picked_up'").run([id]) },
  historyRecipient: { all: () => prepare("SELECT recipient AS value, COUNT(*) AS count FROM packages WHERE recipient IS NOT NULL AND recipient != '' GROUP BY recipient ORDER BY count DESC, recipient ASC").all() },
  historyPhone: { all: () => prepare("SELECT phone AS value, COUNT(*) AS count FROM packages WHERE phone IS NOT NULL AND phone != '' GROUP BY phone ORDER BY count DESC, phone ASC").all() },
  historyAddress: { all: () => prepare("SELECT address AS value, COUNT(*) AS count FROM packages WHERE address IS NOT NULL AND address != '' GROUP BY address ORDER BY count DESC, address ASC").all() },

  insertExpress: { run: (p) => prepare("INSERT INTO packages (pickup_code, company, recipient, phone, address, mail_no, order_id, status, goods_name, account_id, proxy) VALUES (@pickup_code, @company, @recipient, @phone, @address, @mail_no, @order_id, @status, @goods_name, @account_id, @proxy)").run({ pickup_code: p.pickup_code || '', company: p.company || null, recipient: p.recipient || null, phone: p.phone || null, address: p.address || null, mail_no: p.mail_no || null, order_id: p.order_id || null, status: p.status || 'pending', goods_name: p.goods_name || null, account_id: p.account_id || null, proxy: p.proxy ? 1 : 0 }) },
  withOrderId: { all: () => prepare("SELECT * FROM packages WHERE order_id IS NOT NULL AND order_id != '' AND status IN ('shipping','pending') ORDER BY id").all() },
  getByMailNo: { get: (no) => prepare('SELECT * FROM packages WHERE mail_no = ?').get([no]) },
  getByOrderId: { get: (id) => prepare('SELECT * FROM packages WHERE order_id = ?').get([id]) },
  /** 用物流页最新值刷新字段：新值非空才覆盖，避免把已有数据刷成空 */
  updateExpressInfo: { run: (v) => prepare(`UPDATE packages SET
      pickup_code = COALESCE(NULLIF(@pickup_code, ''), pickup_code),
      company     = COALESCE(NULLIF(@company, ''), company),
      recipient   = COALESCE(NULLIF(@recipient, ''), recipient),
      phone       = COALESCE(NULLIF(@phone, ''), phone),
      address     = COALESCE(NULLIF(@address, ''), address),
      mail_no     = COALESCE(NULLIF(@mail_no, ''), mail_no),
      goods_name  = COALESCE(NULLIF(@goods_name, ''), goods_name),
      proxy       = COALESCE(@proxy, proxy),
      updated_at  = datetime('now','localtime')
    WHERE id = @id`).run({ id: v.id, pickup_code: v.pickup_code || '', company: v.company || '', recipient: v.recipient || '', phone: v.phone || '', address: v.address || '', mail_no: v.mail_no || '', goods_name: v.goods_name || '', proxy: v.proxy == null ? null : (v.proxy ? 1 : 0) }) },
  /** 状态只前进：待发货 → 运输中 → 待取件；已取件为终态不可覆盖 */
  promoteStatus: { run: (v) => prepare("UPDATE packages SET status = @status, updated_at = datetime('now','localtime') WHERE id = @id AND status != 'picked_up'").run({ id: v.id, status: v.status }) },
  /**
   * 管理页编辑：全量覆盖，允许清空字段。
   * 与同步用的 updateExpressInfo（COALESCE(NULLIF(...)) 「非空才覆盖」）语义相反 ——
   * 用户手动编辑时必须能把填错的公司/地址真正删掉，而不是被旧值顶回来。
   */
  updatePackage: { run: (p) => prepare(`UPDATE packages SET
      pickup_code = @pickup_code,
      company     = @company,
      recipient   = @recipient,
      phone       = @phone,
      address     = @address,
      updated_at  = datetime('now','localtime')
    WHERE id = @id`).run({ id: p.id, pickup_code: p.pickup_code, company: p.company || null, recipient: p.recipient || null, phone: p.phone || null, address: p.address || null }) },

  logSync: { run: (p) => prepare('INSERT INTO express_sync_log (source, status, detail) VALUES (@source, @status, @detail)').run({ source: p.source, status: p.status, detail: p.detail || null }) },
  lastSync: { get: () => prepare('SELECT * FROM express_sync_log ORDER BY id DESC LIMIT 1').get() },
  lastSyncBySource: { get: (source) => prepare('SELECT * FROM express_sync_log WHERE source = ? ORDER BY id DESC LIMIT 1').get([source]) },

  setSetting: { run: (v) => prepare('INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value').run({ key: v.key, value: v.value }) },
  getSetting: { get: (k) => prepare('SELECT value FROM settings WHERE key = ?').get([k]) },
  deleteSetting: { run: (k) => prepare('DELETE FROM settings WHERE key = ?').run([k]) },

  // 账号（多账号）：cookie 只在后端使用，列表查询不返回该列
  listAccounts: { all: (platform) => prepare('SELECT id, platform, remark, created_at, last_sync_at, last_sync_status FROM accounts WHERE platform = ? ORDER BY id').all([platform]) },
  allAccounts: { all: (platform) => prepare('SELECT * FROM accounts WHERE platform = ? ORDER BY id').all([platform]) },
  /** 各账号名下在途/待取件包裹数（账号卡片展示用） */
  accountStatusCounts: { all: () => prepare("SELECT account_id, status, COUNT(*) AS n FROM packages WHERE account_id IS NOT NULL AND status IN ('shipping','pending') GROUP BY account_id, status").all() },
  getAccount: { get: (id) => prepare('SELECT * FROM accounts WHERE id = ?').get([id]) },
  insertAccount: { run: (a) => prepare('INSERT INTO accounts (platform, remark, cookie) VALUES (@platform, @remark, @cookie)').run({ platform: a.platform, remark: a.remark || null, cookie: a.cookie }) },
  updateAccountRemark: { run: (a) => prepare('UPDATE accounts SET remark = @remark WHERE id = @id').run({ id: a.id, remark: a.remark || null }) },
  updateAccountCookie: { run: (a) => prepare('UPDATE accounts SET cookie = @cookie WHERE id = @id').run({ id: a.id, cookie: a.cookie }) },
  updateAccountSync: { run: (v) => prepare("UPDATE accounts SET last_sync_at = datetime('now','localtime'), last_sync_status = @status, last_sync_detail = @detail WHERE id = @id").run({ id: v.id, status: v.status, detail: v.detail || null }) },
  deleteAccount: { run: (id) => prepare('DELETE FROM accounts WHERE id = ?').run([id]) },
}

module.exports = { init, getDb, stmts, save }
