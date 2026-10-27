const { stmts } = require('./db')

/** 「代取快递」默认关键词：命中即视为被代收/代签（别人代收或柜机代收，无需本人当面签收） */
const DEFAULT_PROXY_KEYWORDS = ['前台', '门卫', '代收点', '代收', '代签', '物业', '保安', '丰巢', '快递柜', '自提柜']

/** 自动更新频率可选值（分钟） */
const SYNC_INTERVALS = [30, 60, 180, 360, 720, 1440]

const DEFAULTS = {
  show_proxy: '1',
  proxy_keywords: DEFAULT_PROXY_KEYWORDS.join(','),
  sync_interval: '60',
}

function readKey(key) {
  const row = stmts.getSetting.get(key)
  // 只有「从未配置」才回退默认值；显式保存的空串要尊重（否则用户清空关键词后会被默认值顶回来）
  return row && row.value != null ? row.value : DEFAULTS[key]
}

/** 展示设置：是否显示代取快递 + 代取关键词 + 自动更新频率 */
function getDisplaySettings() {
  const showProxy = readKey('show_proxy') !== '0'
  const keywords = readKey('proxy_keywords')
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)
  const rawInterval = Number(readKey('sync_interval'))
  const syncInterval = SYNC_INTERVALS.includes(rawInterval) ? rawInterval : 60
  return { showProxy, keywords, syncInterval }
}

/** 只写入传入的字段（undefined 表示不改动） */
function saveDisplaySettings({ showProxy, keywords, syncInterval }) {
  if (showProxy !== undefined) {
    stmts.setSetting.run({ key: 'show_proxy', value: showProxy ? '1' : '0' })
  }
  if (keywords !== undefined) {
    stmts.setSetting.run({ key: 'proxy_keywords', value: String(keywords) })
  }
  if (syncInterval !== undefined && SYNC_INTERVALS.includes(Number(syncInterval))) {
    stmts.setSetting.run({ key: 'sync_interval', value: String(Number(syncInterval)) })
  }
}

/** 物流文案命中关键词 → 属于「代取快递」 */
function isProxyText(text, keywords) {
  if (!text) return false
  return keywords.some(k => text.includes(k))
}

/**
 * 判断一条包裹是否属于「代取快递」。
 * 只按「当前关键词 + 地址」实时判定 —— 不再 OR 同步时存下的 proxy 快照，
 * 否则删掉某个关键词后，之前被标记的件会永远隐藏、无法恢复。
 */
function isProxyRow(row, keywords) {
  if (!row) return false
  const addr = row.address || ''
  return addr !== '' && keywords.some(k => addr.includes(k))
}

module.exports = { DEFAULT_PROXY_KEYWORDS, SYNC_INTERVALS, getDisplaySettings, saveDisplaySettings, isProxyText, isProxyRow }
