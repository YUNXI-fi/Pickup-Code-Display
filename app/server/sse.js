const { getDisplaySettings, isProxyRow } = require('./settings')

const clients = []

function broadcast(event, data) {
  // 「代取快递」被隐藏时不下发 create/update（数据仍保留在库中）。
  // 统一在出口过滤 —— 同步、取件、编辑、手动添加等所有推送点都自动一致。
  // delete 不拦截：客户端若残留该行，正好借机清掉。
  if (event !== 'delete' && data && data.id !== undefined) {
    const { showProxy, keywords } = getDisplaySettings()
    if (!showProxy && isProxyRow(data, keywords)) return
  }
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(msg)
}

function addClient(res) {
  clients.push(res)
  res.on('close', () => {
    const i = clients.indexOf(res)
    if (i >= 0) clients.splice(i, 1)
  })
}

module.exports = { broadcast, addClient }