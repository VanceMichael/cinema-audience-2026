// 值班对账编排：把来源客户端、闸机客户端、纯模型与本地状态串起来。
// 关键顺序固定为：请档 -> 判实际放行 -> 判适用单场权益 -> 按票包累计独立观众 -> 才允许封账。

import { SourceClient } from './source-client.mjs'
import { ProviderClient } from './gate-client.mjs'
import { Store } from './store.mjs'
import {
  mergeEditions, buildVoucherResolver, mergeGateRecords, buildSegments,
  reconcileEvent, parseStream
} from './model.mjs'

const ALL_STREAMS = ['events', 'passes', 'exchange', 'gates', 'files', 'closed']

export class Desk {
  constructor({ sourceRoot, providerRoot, statePath, archiveDir }) {
    this.source = new SourceClient(sourceRoot)
    this.provider = new ProviderClient(providerRoot)
    this.store = new Store(statePath)
    this.archiveDir = archiveDir
  }

  async init() {
    await this.store.load()
    return this
  }

  // 领取新一期资料：分页拉全当期声明的数据流并落本地；旧版资料保留，由模型做合并。
  async ingest(edition) {
    const catalog = await this.source.catalog()
    const target = edition || catalog.edition
    const streams = {}
    for (const name of ALL_STREAMS) {
      // 某一期可能尚未出现某条流（如 r1 没有 exchange），缺席按空流处理，不报错。
      streams[name] = catalog.streams.includes(name)
        ? await this.source.fetchStream(name, { edition: target })
        : []
    }
    this.store.recordEdition(target, streams)
    await this.store.save()
    return { edition: target, counts: Object.fromEntries(Object.entries(streams).map(([k, v]) => [k, v.length])) }
  }

  domain() {
    const merged = mergeEditions(this.store.mergedSnapshots())
    return merged
  }

  // 按所涉影片（场次）列出需要请求档案的 (影院, 影厅, 自然日) 分段。
  requiredArchives(show) {
    const { events } = this.domain()
    const event = events.find(item => item.show === show)
    if (!event) throw new Error(`没有场次 ${show}`)
    return event.days.map(day => ({ house: event.house, room: event.room, day }))
  }

  // 请档：对每个所涉自然日向闸机源请求索引并下载物理档；
  // 允许提前上传未封尾、允许范围相交的重复副本——全部留档，封尾判定交给模型。
  // 同一档案路径再次投递时，旧登记标注 superseded 并保留原件（晚传文件不能抹掉历史）。
  async requestArchives(show) {
    const requests = this.requiredArchives(show)
    const downloaded = []
    for (const request of requests) {
      const indices = await this.provider.archives(request.house, request.day)
      for (const archive of indices) {
        const dir = `${this.archiveDir}/${request.house}-${request.room}-day${request.day}`
        const bundle = await this.provider.downloadArchive(archive, dir)
        for (const old of this.store.state.archives) {
          if (old.archive.path === archive.path && !old.superseded) old.superseded = true
        }
        const entry = {
          archive, etag: bundle.etag, diskPath: bundle.diskPath,
          records: bundle.records,
          id: `${archive.path}@${archive.range.join('-')}:${bundle.diskPath}`
        }
        this.store.recordArchive(entry)
        downloaded.push(entry)
      }
    }
    await this.store.save()
    return downloaded
  }

  // 单场核算：合并来源 gates 索引与物理档，先判放行再判权益，最后按票包去重。
  reconcile(show) {
    const domain = this.domain()
    const event = domain.events.find(item => item.show === show)
    if (!event) throw new Error(`没有场次 ${show}`)
    const resolveVoucher = buildVoucherResolver(domain.passes, domain.exchanges)

    const archiveEntries = this.store.state.archives.filter(entry => {
      if (entry.superseded) return false
      const index = entry.archive
      return index.house === event.house && index.room === event.room && event.days.includes(Number(index.day))
    })
    const archiveIndices = archiveEntries.map(entry => entry.archive)
    const archiveBundles = archiveEntries.map(entry => ({
      id: entry.id,
      records: entry.records,
      house: entry.archive.house,
      room: entry.archive.room,
      day: Number(entry.archive.day),
      path: entry.archive.path
    }))
    const archivedRows = archiveEntries.flatMap(entry => entry.records.map(record => ([
      event.house, event.room,
      String(Math.floor(Number(record.at) / 1440) + 1),
      record.show, String(record.at), record.voucher, record.allowed ? '1' : '0'
    ])))
    const archivedGates = parseStream('gates', archivedRows)
    const { records: gateRecords, conflicts: mergeConflicts } =
      mergeGateRecords(domain.gates, archivedGates)
    const segments = buildSegments(event, {
      sourceFiles: domain.files,
      archiveIndices,
      archiveBundles,
      gateRecords
    })
    const result = reconcileEvent(event, {
      resolveVoucher, gateRecords, segments,
      archiveConflicts: mergeConflicts
    })
    result.ledgerLines = domain.closed
      .filter(line => line.show === show)
      .map(line => ({ entitlement: line.entitlement, voucher: line.voucher, line: line.line }))
    result.sealed = this.store.isSealed(show) ? this.store.state.sealed[show] : null
    return result
  }

  // 资料齐的影院场次可以先封；缺尾/断档/冲突一律拒绝，绝不按零人封账。
  async seal(show) {
    const result = this.reconcile(show)
    if (result.status.kind !== 'sealed-evidence') {
      const error = new Error(`场次 ${show} 证据不齐，不能封账：${result.status.reason}`)
      error.code = 'NOT_SEALABLE'
      error.detail = result.status.blocking || result.conflicts
      throw error
    }
    this.store.seal(show, {
      show,
      house: this.domain().events.find(e => e.show === show).house,
      audience: result.provisionalAudience,
      audienceByPass: result.audience.map(a => ({
        pass: a.pass, entitlements: a.entitlements, vouchers: a.vouchers
      })),
      evidence: result.admissions.map(a => ({
        at: a.at, voucher: a.voucher, entitlement: a.entitlement, pass: a.pass, origins: a.copies
      })),
      ledgerLines: result.ledgerLines
    })
    await this.store.save()
    return this.store.state.sealed[show]
  }

  // 已封后到跨影院换场回执：重算旧场与新场。观众数没变也必须出更正件（delta=0），
  // 只修订凭据；合作台 202 待确认、409 账期未办时保留待办，不得互相抵清。
  // provisional=true 用于新场物理档已到但当天尚未封尾：先挂待办，被 409 拒绝后继续等待，
  // 绝不能把未确认差额与旧场更正互相抵清。
  async amend({ show, line, extra = {}, provisional = false }) {
    const before = this.store.state.sealed[show]
    const after = this.reconcile(show)
    const waiting = this.store.state.amendments.find(a => a.show === show && a.line === line)
    // delta 语义：
    // - 已封账场次的（再次）更正：与封账快照相减，观众没变就是 0，只修订凭据；
    // - 此前仅被 409 挂起、从未入账的预提：首次受理时增减等于本场有证实到本身。
    let delta = null
    let audienceBefore = null
    const onlyWaiting = waiting && waiting.state === 'waiting-period'
    if (before && !onlyWaiting) {
      audienceBefore = before.audience
      delta = after.status.kind === 'sealed-evidence' ? after.provisionalAudience - before.audience : null
    } else if (after.status.kind === 'sealed-evidence') {
      delta = after.provisionalAudience
    }
    const beforeEntitlements = new Set(before ? before.audienceByPass.flatMap(a => a.entitlements) : [])
    const afterEntitlements = new Set(after.audience.flatMap(a => a.entitlements))
    if (!provisional && !before) {
      const error = new Error(`场次 ${show} 尚未封账；如确认要向合作台预提待办，请显式使用 provisional 模式`)
      error.code = 'NOT_SEALED'
      throw error
    }
    // 同一 (场, 账行) 只保留一条工作项：正式提交会并掉此前的预提待办，差额绝不重复挂账。
    const entry = waiting || { show, line, requestedAt: new Date().toISOString() }
    Object.assign(entry, {
      provisional: !before,
      audienceBefore,
      audienceAfter: after.provisionalAudience,
      audienceDelta: delta,
      deltaByEntitlement: {
        removed: [...beforeEntitlements].filter(e => !afterEntitlements.has(e)),
        added: [...afterEntitlements].filter(e => !beforeEntitlements.has(e)),
        retained: [...afterEntitlements].filter(e => beforeEntitlements.has(e))
      },
      commonEvidence: after.admissions.map(a => ({ at: a.at, voucher: a.voucher, entitlement: a.entitlement })),
      blocking: after.status.blocking || [],
      note: extra.note || '',
      state: 'pending'
    })
    if (!waiting) this.store.state.amendments.push(entry)
    await this.store.save()
    let response
    try {
      response = await this.provider.amend({
        show, line,
        entitlementRefs: entry.deltaByEntitlement,
        audienceDelta: delta,
        ...extra
      })
    } catch (networkError) {
      this.store.updateAmendment(show, line, { state: 'send-failed', error: networkError.message })
      await this.store.save()
      throw networkError
    }
    const patch = response.status === 202
      ? { state: 'received', providerBody: response.body }
      : response.status === 409
        ? { state: 'waiting-period', providerBody: response.body }
        : { state: `unexpected-${response.status}`, providerBody: response.body }
    this.store.updateAmendment(show, line, patch)
    await this.store.save()
    return { status: response.status, amendment: this.store.state.amendments.find(a => a.show === show && a.line === line) }
  }

  // 读回合作台回执；待确认的差额仍然挂账，不与任何新场结账互相抵清。
  async refreshReceipts() {
    const receipts = await this.provider.receipts()
    this.store.syncReceipts(receipts)
    await this.store.save()
    return receipts
  }

  async refreshLedger() {
    const lines = await this.provider.settlementLines()
    this.store.cacheLedgerLines(lines)
    await this.store.save()
    return lines
  }

  // 按合作影院查场次、实际进度与对应账行。
  houseReport(house) {
    const { events } = this.domain()
    return events.filter(event => event.house === house).map(event => {
      const result = this.reconcile(event.show)
      return {
        show: event.show, room: event.room, businessDay: event.businessDay,
        window: { from: event.from, until: event.until, days: event.days },
        sealed: Boolean(result.sealed),
        status: result.status,
        provisionalAudience: result.provisionalAudience,
        ledgerLines: result.ledgerLines,
        blocking: result.status.blocking || []
      }
    })
  }

  // 按票包追到每场使用凭据，并指出还缺哪段档案。
  passReport(pass) {
    const { passes } = this.domain()
    const entitlements = passes.filter(p => p.pass === pass)
    if (!entitlements.length) {
      const error = new Error(`没有票包 ${pass}`)
      error.code = 'UNKNOWN_PASS'
      throw error
    }
    const { events } = this.domain()
    const perShow = []
    for (const event of events) {
      const result = this.reconcile(event.show)
      const mine = result.audience.find(a => a.pass === pass)
      const attempts = [...result.admissions, ...result.rejected]
        .filter(scan => scan.pass === pass)
        .map(scan => ({
          show: event.show, at: scan.at, voucher: scan.voucher,
          entitlement: scan.entitlement || null, admitted: scan.admitted, reason: scan.reason,
          origins: scan.copies || []
        }))
      if (mine || attempts.length) {
        perShow.push({
          show: event.show,
          counted: Boolean(mine),
          scans: mine ? mine.scans : [],
          attempts,
          missingSegments: (result.status.blocking || []).map(b => ({ day: b.day, kind: b.kind, reasons: b.reasons }))
        })
      }
    }
    return {
      pass,
      entitlements: entitlements.map(e => ({ entitlement: e.entitlement, voucher: e.voucher, show: e.show })),
      perShow
    }
  }
}
