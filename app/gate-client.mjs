// 外部影厅闸机源与合作账台客户端，语义见 source/provider.md。
// 下载的档案属于不可信数据：写入调用方指定的独立目录，只做 gunzip + JSON 行解析，
// 不执行其中任何内容；文件路径只接受服务端登记的白名单，防止路径穿越。

import { gunzipSync } from 'node:zlib'
import { writeFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

// 档案路径必须是闸机源登记的 /gates/ 下简单相对段，拒绝绝对路径、穿越与异常协议。
function isSafeArchivePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/gates/')) return false
  const tail = path.slice('/gates/'.length)
  return tail.length > 0 && tail.split('/').every(segment =>
    segment.length > 0 && !segment.includes('..') && !segment.includes('\\') && !segment.includes('\0'))
}

export class ProviderClient {
  constructor(root, { timeoutMs = 10000, maxAttempts = 3 } = {}) {
    this.root = root.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.maxAttempts = maxAttempts
  }

  // GET /gates/archives?house=&date=：物理厅、自然日、序号范围、封尾位与文件路径。
  // 该分段暂无任何登记时闸机源给 404，调用方按空索引处理并回退到来源 files 流。
  async archives(house, date) {
    const query = new URLSearchParams({ house, date: String(date) })
    const response = await this.#request(`/gates/archives?${query}`)
    if (response.status === 404) return []
    if (!response.ok) {
      const error = new Error(`档案索引 ${house}/${date} 返回 ${response.status}`)
      error.statusCode = response.status
      throw error
    }
    const list = await response.json()
    for (const item of list) {
      if (!isSafeArchivePath(item.path)) {
        throw new Error(`档案路径 ${item.path} 未通过安全校验，拒绝下载`)
      }
    }
    return list
  }

  // 下载并解包一份闸机档。支持 Range 续传与响应 ETag 留档；
  // 演练服务可能直接掐断连接（route.drop），此处对网络层错误做有限重试。
  async downloadArchive(archive, destinationDir) {
    await mkdir(destinationDir, { recursive: true })
    const url = this.root + archive.path
    let buffer = Buffer.alloc(0)
    let etag
    for (let attempt = 1; ; attempt += 1) {
      try {
        const headers = {}
        if (buffer.length) headers.Range = `bytes=${buffer.length}-`
        const response = await this.#request(url, { headers })
        if (response.status === 416 && buffer.length) break // 本地已取完整文件
        if (response.status !== 200 && response.status !== 206) {
          throw new Error(`下载 ${archive.path} 返回 ${response.status}`)
        }
        etag = response.headers.get('etag') || null
        const chunk = Buffer.from(await response.arrayBuffer())
        if (response.status === 206) {
          const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(response.headers.get('content-range') || '')
          if (!range) throw new Error('206 响应缺少 Content-Range')
          const start = Number(range[1])
          if (start !== buffer.length) throw new Error('续传起点与本地长度不一致，档案可能被替换')
          buffer = Buffer.concat([buffer, chunk])
          if (buffer.length !== Number(range[3])) continue
        } else {
          buffer = chunk
        }
        break
      } catch (error) {
        // fetch 在连接被对端销毁时抛 TypeError；4xx/5xx 已在上面转成普通 Error，不重试。
        if (attempt >= this.maxAttempts || error.name !== 'TypeError') throw error
        await new Promise(resolve => setTimeout(resolve, 50 * attempt))
      }
    }
    const safeName = basename(archive.path) + '.jsonl.gz'
    let diskPath = join(destinationDir, safeName)
    try {
      await writeFile(diskPath, buffer, { flag: 'wx' })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      // 同一物理档重复投递时保留两份原件，副本另起文件名，绝不覆盖已核对的原件。
      diskPath = join(destinationDir, `${basename(archive.path)}-${Date.now()}.jsonl.gz`)
      await writeFile(diskPath, buffer)
    }
    let lines
    try {
      lines = gunzipSync(buffer).toString('utf8').split('\n').filter(Boolean)
    } catch (error) {
      throw new Error(`档案 ${archive.path} 不是有效的 gzip 数据：${error.message}`)
    }
    const records = lines.map((line, index) => {
      try {
        const record = JSON.parse(line)
        for (const field of ['device', 'gen', 'seq', 'at', 'show', 'allowed']) {
          if (record[field] === undefined) throw new Error(`缺少字段 ${field}`)
        }
        return record
      } catch (error) {
        throw new Error(`档案 ${archive.path} 第 ${index + 1} 行无法解析：${error.message}`)
      }
    })
    return { archive, diskPath, etag, records }
  }

  // 合作账台：账期与已签账状态。
  async settlementLines() {
    const response = await this.#request('/settlement/lines')
    if (!response.ok) throw new Error(`账台账行查询返回 ${response.status}`)
    return response.json()
  }

  // 合作账台：提交更正。202 = 待确认；409 = 目标账期当前未办（调用方据此继续等待）。
  async amend(payload) {
    const response = await this.#request('/settlement/amend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }

  // 合作账台：按账行读回实际结论。
  async receipts() {
    const response = await this.#request('/settlement/receipts')
    if (!response.ok) throw new Error(`回执查询返回 ${response.status}`)
    return response.json()
  }

  async #request(path, init = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const url = path.startsWith('http') ? path : this.root + path
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}
