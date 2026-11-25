// 值班台本地状态：已封场快照、已提交更正与合作台回执、物理档下载登记。
// 单个 JSON 文件原子写入；所有对外动作先落本地凭据，再允许提交合作台。

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const EMPTY = {
  editions: [],          // 已领取资料版（按领取顺序）
  snapshots: {},         // edition -> 各流原始行
  sealed: {},            // show -> 封账快照
  amendments: [],        // 已提交/待提交的更正
  receipts: [],          // 合作台读回的回执
  archives: [],          // 已下载物理档登记
  ledgerLines: []        // 合作台账行缓存
}

export class Store {
  constructor(path) {
    this.path = path
    this.state = structuredClone(EMPTY)
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      this.state = { ...structuredClone(EMPTY), ...JSON.parse(raw) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return this
  }

  async save() {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(this.state, null, 2))
    await rename(tmp, this.path)
  }

  recordEdition(edition, streams) {
    if (!this.state.editions.includes(edition)) this.state.editions.push(edition)
    this.state.snapshots[edition] = streams
  }

  mergedSnapshots() {
    return this.state.editions.map(edition => ({ edition, streams: this.state.snapshots[edition] }))
  }

  isSealed(show) {
    return Object.hasOwn(this.state.sealed, show)
  }

  seal(show, snapshot) {
    this.state.sealed[show] = { ...snapshot, sealedAt: new Date().toISOString() }
  }

  recordArchive(entry) {
    const key = `${entry.archive.path}:${entry.diskPath}`
    if (!this.state.archives.some(item => `${item.archive.path}:${item.diskPath}` === key)) {
      this.state.archives.push({ ...entry, downloadedAt: new Date().toISOString() })
    }
  }

  updateAmendment(show, line, patch) {
    const target = this.state.amendments.find(item => item.show === show && item.line === line)
    if (target) Object.assign(target, patch)
  }

  syncReceipts(receipts) {
    this.state.receipts = receipts
  }

  cacheLedgerLines(lines) {
    this.state.ledgerLines = lines
  }
}
