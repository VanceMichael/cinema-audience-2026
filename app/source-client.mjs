// 资料来源客户端：负责 /catalog、/records/{stream} 的分页领取、资料版隔离与条件请求。
// 来源约定见 source/formats.md：制表符分隔、每页至多两行、Link rel="next" 翻页。

const STREAMS = ['events', 'passes', 'exchange', 'gates', 'files', 'closed']

async function readResponse(response) {
  const text = await response.text()
  if (!text) return []
  return text.split('\n').filter(Boolean).map(line => line.split('\t'))
}

export class SourceClient {
  constructor(root, { timeoutMs = 10000 } = {}) {
    this.root = root.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  async getJson(path) {
    const response = await this.#request(path)
    if (!response.ok) throw new Error(`来源 ${path} 返回 ${response.status}`)
    return response.json()
  }

  // 显式切换来源保留的资料版（模拟业务方更换当期资料）。
  async selectEdition(edition) {
    const response = await this.#request(`/control?edition=${encodeURIComponent(edition)}`, { method: 'POST' })
    if (!response.ok) throw new Error(`切换资料版 ${edition} 被拒：${response.status}`)
    return (await response.json()).edition
  }

  async catalog() {
    return this.getJson('/catalog')
  }

  // 领取某一资料版下的整条数据流，自动跟随 next 链接；筛选条件透传 key/from/until。
  // 继续标记只在同一资料版、同一筛选条件下有效，翻页时不改动其它查询参数。
  async fetchStream(stream, { edition, key, from, until } = {}) {
    if (!STREAMS.includes(stream)) throw new Error(`未知数据流 ${stream}`)
    const params = new URLSearchParams()
    if (edition) params.set('edition', edition)
    if (key !== undefined && key !== null) params.set('key', key)
    if (from !== undefined && from !== null) params.set('from', String(from))
    if (until !== undefined && until !== null) params.set('until', String(until))
    let path = `/records/${stream}?${params.toString()}`
    const rows = []
    const seen = new Set()
    while (path) {
      const response = await this.#request(path)
      if (response.status === 404 || response.status === 409 || response.status === 422) {
        throw new Error(`领取 ${stream} 失败：HTTP ${response.status}`)
      }
      if (!response.ok) throw new Error(`领取 ${stream} 失败：HTTP ${response.status}`)
      for (const row of await readResponse(response)) {
        const fingerprint = JSON.stringify(row)
        if (seen.has(fingerprint)) continue // 防御性去重，翻页不应出现重复行
        seen.add(fingerprint)
        rows.push(row)
      }
      const link = response.headers.get('link')
      const next = link && /rel="next"/.test(link) ? /^<([^>]+)>/.exec(link)?.[1] : null
      path = next
    }
    return rows
  }

  async #request(path, init = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(this.root + path, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

export { STREAMS }
