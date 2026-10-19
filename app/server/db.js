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
    source_platform TEXT DEFAULT 'manual'
  )`)
  // 兼容旧库：补齐历史版本缺失的列（新库已全部包含，ALTER 会抛错并被忽略）
  try { db.run("ALTER TABLE packages ADD COLUMN company TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN address TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN mail_no TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN order_id TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN goods_name TEXT") } catch (_) {}
  try { db.run("ALTER TABLE packages ADD COLUMN source_platform TEXT DEFAULT 'manual'") } catch (_) {}

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
      source_platform TEXT DEFAULT 'manual'
    )`)
    db.run(`INSERT INTO packages (id, pickup_code, recipient, phone, address, company, status, created_at, picked_up_at, mail_no, order_id, goods_name, source_platform)
            SELECT id, pickup_code, recipient, phone, address, company, status, created_at, picked_up_at, mail_no, order_id, goods_name, source_platform FROM packages_old`)
    db.run('DROP TABLE packages_old')
  }
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
  save()
}

function getDb() { return db }

const stmts = {
  all: { all: () => prepare('SELECT * FROM packages ORDER BY created_at DESC').all() },
  pending: { all: () => prepare("SELECT * FROM packages WHERE status = 'pending' ORDER BY created_at DESC").all() },
  getById: { get: (id) => prepare('SELECT * FROM packages WHERE id = ?').get([id]) },
  insert: { run: (p) => prepare('INSERT INTO packages (pickup_code, company, recipient, phone, address, source_platform) VALUES (@pickup_code, @company, @recipient, @phone, @address, @source_platform)').run({ pickup_code: p.pickup_code, company: p.company || null, recipient: p.recipient || null, phone: p.phone || null, address: p.address || null, source_platform: p.source_platform || 'manual' }) },
  pickup: { run: (id) => prepare("UPDATE packages SET status = 'picked_up', picked_up_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'").run([id]) },
  remove: { run: (id) => prepare('DELETE FROM packages WHERE id = ?').run([id]) },
  restore: { run: (id) => prepare("UPDATE packages SET status = 'pending', picked_up_at = NULL WHERE id = ? AND status = 'picked_up'").run([id]) },
  historyRecipient: { all: () => prepare("SELECT recipient AS value, COUNT(*) AS count FROM packages WHERE recipient IS NOT NULL AND recipient != '' GROUP BY recipient ORDER BY count DESC, recipient ASC").all() },
  historyPhone: { all: () => prepare("SELECT phone AS value, COUNT(*) AS count FROM packages WHERE phone IS NOT NULL AND phone != '' GROUP BY phone ORDER BY count DESC, phone ASC").all() },
  historyAddress: { all: () => prepare("SELECT address AS value, COUNT(*) AS count FROM packages WHERE address IS NOT NULL AND address != '' GROUP BY address ORDER BY count DESC, address ASC").all() },

  insertExpress: { run: (p) => prepare("INSERT INTO packages (pickup_code, company, recipient, phone, address, mail_no, order_id, status, goods_name, source_platform) VALUES (@pickup_code, @company, @recipient, @phone, @address, @mail_no, @order_id, @status, @goods_name, @source_platform)").run({ pickup_code: p.pickup_code || '', company: p.company || null, recipient: p.recipient || null, phone: p.phone || null, address: p.address || null, mail_no: p.mail_no || null, order_id: p.order_id || null, status: p.status || 'pending', goods_name: p.goods_name || null, source_platform: p.source_platform || 'manual' }) },
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
      goods_name  = COALESCE(NULLIF(@goods_name, ''), goods_name)
      ,source_platform = COALESCE(NULLIF(@source_platform, ''), source_platform)
    WHERE id = @id`).run({ id: v.id, pickup_code: v.pickup_code || '', company: v.company || '', recipient: v.recipient || '', phone: v.phone || '', address: v.address || '', mail_no: v.mail_no || '', goods_name: v.goods_name || '', source_platform: v.source_platform || '' }) },
  /** 状态只前进：待发货 → 运输中 → 待取件；已取件为终态不可覆盖 */
  promoteStatus: { run: (v) => prepare("UPDATE packages SET status = @status WHERE id = @id AND status != 'picked_up'").run({ id: v.id, status: v.status }) },

  logSync: { run: (p) => prepare('INSERT INTO express_sync_log (source, status, detail) VALUES (@source, @status, @detail)').run({ source: p.source, status: p.status, detail: p.detail || null }) },
  lastSync: { get: () => prepare('SELECT * FROM express_sync_log ORDER BY id DESC LIMIT 1').get() },

  setSetting: { run: (v) => prepare('INSERT INTO settings (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value').run({ key: v.key, value: v.value }) },
  getSetting: { get: (k) => prepare('SELECT value FROM settings WHERE key = ?').get([k]) },
  allSettings: { all: () => prepare('SELECT key, value FROM settings ORDER BY key').all() },
  deleteSetting: { run: (k) => prepare('DELETE FROM settings WHERE key = ?').run([k]) },
}

module.exports = { init, getDb, stmts, save }
