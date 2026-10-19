const { stmts } = require('./db')
const crypto = require('crypto')

function key(platform, id) { return `${platform}_account:${id}` }
function legacyKey(platform) { return `${platform}_cookie` }

function list(platform) {
  const prefix = `${platform}_account:`
  const rows = stmts.allSettings.all().filter(r => r.key.startsWith(prefix)).map(r => {
    try { return JSON.parse(r.value) } catch (_) { return null }
  }).filter(Boolean)
  // Once the account-scoped format exists, the legacy single-cookie key must
  // not be allowed to recreate a deleted account later.
  if (rows.length) stmts.deleteSetting.run(legacyKey(platform))
  // Upgrade the former single-cookie setting on first read.
  if (!rows.length) {
    const legacy = stmts.getSetting.get(legacyKey(platform))
    if (legacy && legacy.value) {
      const account = { id: 'default', name: `${platform === 'taobao' ? '淘宝' : '拼多多'}账号 1`, cookie: legacy.value, created_at: new Date().toISOString() }
      stmts.setSetting.run({ key: key(platform, account.id), value: JSON.stringify(account) })
      stmts.deleteSetting.run(legacyKey(platform))
      rows.push(account)
    }
  }
  return rows
}

function get(platform, id) { return list(platform).find(a => a.id === id) || null }
function save(platform, account) {
  stmts.setSetting.run({ key: key(platform, account.id), value: JSON.stringify(account) })
  return account
}
function remove(platform, id) {
  stmts.deleteSetting.run(key(platform, id))
  // Prevent the deleted legacy single-account value from being migrated back.
  stmts.deleteSetting.run(legacyKey(platform))
}
function normalizeId(id) { return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || crypto.randomUUID() }

module.exports = { list, get, save, remove, normalizeId }
