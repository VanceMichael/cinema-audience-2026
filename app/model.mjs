// 纯业务模型：解析来源行、解析换场权益、判定实际放行与适用单场权益、
// 区分缺尾/断档/冲突、按票包去重独立观众。本模块不做任何网络与文件操作。

// ---- 时间与自然日 ---------------------------------------------------------
// 自然日从 1 编起；换场与闸机时间均为相对首日零点的累计分钟。
export const MINUTES_PER_DAY = 1440
export const naturalDay = minute => Math.floor(Number(minute) / MINUTES_PER_DAY) + 1
export const dayStart = day => (day - 1) * MINUTES_PER_DAY

// ---- 来源行解析（列号见 source/formats.md） -------------------------------
export function parseEvent(row) {
  const [show, house, room, businessDay, fromDay, fromMinute, untilMinute] = row
  const from = (Number(fromDay) - 1) * MINUTES_PER_DAY + Number(fromMinute)
  // until 是当日窗口的右开边界，换算为累计分钟时仍落在最后一个覆盖自然日内。
  const until = (Number(fromDay) - 1) * MINUTES_PER_DAY + Number(untilMinute)
  return {
    kind: 'event', show, house, room,
    businessDay, fromDay: Number(fromDay), from, until,
    days: daysBetween(from, until)
  }
}

export function parsePass(row) {
  const [pass, entitlement, voucher, show] = row
  return { kind: 'pass', pass, entitlement, voucher, show }
}

export function parseExchange(row) {
  const [entitlement, oldVoucher, newVoucher, intoShow, effectiveAt] = row
  return {
    kind: 'exchange', entitlement, oldVoucher, newVoucher,
    intoShow, effectiveAt: Number(effectiveAt)
  }
}

export function parseGate(row) {
  const [house, room, day, show, at, voucher, allowed] = row
  return {
    kind: 'gate', house, room, day: Number(day), show,
    at: Number(at), voucher, allowed: allowed === '1'
  }
}

export function parseFile(row) {
  const [house, room, day, order, complete] = row
  return { kind: 'file', house, room, day: Number(day), order: Number(order), complete: complete === '1' }
}

export function parseClosed(row) {
  const [show, entitlement, voucher, line] = row
  return { kind: 'closed', show, entitlement, voucher, line }
}

const PARSERS = {
  events: parseEvent, passes: parsePass, exchange: parseExchange,
  gates: parseGate, files: parseFile, closed: parseClosed
}

export function parseStream(name, rows) {
  const parser = PARSERS[name]
  if (!parser) throw new Error(`未知数据流 ${name}`)
  return rows.map(parser)
}

function daysBetween(from, until) {
  const days = new Set()
  for (let minute = from; minute < until; minute += 1) days.add(naturalDay(minute))
  return [...days].sort((a, b) => a - b)
}

// ---- 多资料版合并：主键去重，后继资料版未更新的流继续保留 ------------------
const PRIMARY_KEY = {
  event: e => `event:${e.show}`,
  pass: p => `pass:${p.entitlement}:${p.voucher}`,
  exchange: x => `exchange:${x.entitlement}:${x.effectiveAt}`,
  gate: g => `gate:${g.house}|${g.room}|${g.day}|${g.at}|${g.voucher}`,
  file: f => `file:${f.house}|${f.room}|${f.day}|${f.order}`,
  closed: c => `closed:${c.show}|${c.entitlement}|${c.voucher}`
}

export function mergeEditions(snapshots) {
  // snapshots: [{ edition, streams: { events: rows, ... } }]，按领取时间先后排列。
  const map = new Map()
  for (const snapshot of snapshots) {
    for (const [stream, rows] of Object.entries(snapshot.streams)) {
      for (const record of parseStream(stream, rows)) {
        map.set(PRIMARY_KEY[record.kind](record), record)
      }
    }
  }
  const merged = { events: [], passes: [], exchanges: [], gates: [], files: [], closed: [] }
  for (const record of map.values()) {
    const bucket = { event: 'events', pass: 'passes', exchange: 'exchanges', gate: 'gates', file: 'files', closed: 'closed' }[record.kind]
    merged[bucket].push(record)
  }
  return merged
}

// ---- 换场后的券-权益解析 --------------------------------------------------
// 换场按扫码现场时刻判定：生效时刻之前旧券仍属原权益；之后旧券失效、新券生效。
// 新券不在 passes 表内，但通过 exchange 可追溯回原票包与权益。
// 换场只迁走被点名的那一项权益，不迁走整张票包。
export function buildVoucherResolver(passes, exchanges) {
  const byVoucher = new Map()
  for (const pass of passes) {
    if (!byVoucher.has(pass.voucher)) byVoucher.set(pass.voucher, [])
    byVoucher.get(pass.voucher).push(pass)
  }
  const entitlementOwner = new Map(passes.map(pass => [pass.entitlement, pass]))
  const exchangesByEntitlement = new Map()
  for (const exchange of exchanges) {
    if (!exchangesByEntitlement.has(exchange.entitlement)) exchangesByEntitlement.set(exchange.entitlement, [])
    exchangesByEntitlement.get(exchange.entitlement).push(exchange)
  }
  return function resolve(voucher, at) {
    const owners = byVoucher.get(voucher) || []
    for (const pass of owners) {
      const moves = (exchangesByEntitlement.get(pass.entitlement) || [])
        .filter(move => move.oldVoucher === voucher || move.newVoucher === voucher)
        .sort((a, b) => a.effectiveAt - b.effectiveAt)
      const activeMove = moves.findLast(move => move.effectiveAt <= at)
      if (!activeMove) return { pass: pass.pass, entitlement: pass.entitlement, show: pass.show, status: 'active' }
      if (activeMove.newVoucher === voucher) {
        return { pass: pass.pass, entitlement: pass.entitlement, show: activeMove.intoShow, status: 'exchanged-in', exchange: activeMove }
      }
      // 扫码时刻晚于换场生效点却仍出示旧券：该权益已不在此券上。
      return { pass: pass.pass, entitlement: pass.entitlement, show: pass.show, status: 'stale-voucher', exchange: activeMove }
    }
    // 券只可能是换场新券：经 exchange 反查权益与票包，并核对扫码时刻不早于生效点。
    const birth = exchanges.find(move => move.newVoucher === voucher)
    if (birth) {
      const owner = entitlementOwner.get(birth.entitlement)
      if (at < birth.effectiveAt) return null // 新券在生效时刻之前出示，不成立
      return {
        pass: owner.pass, entitlement: birth.entitlement,
        show: birth.intoShow, status: 'exchanged-in', exchange: birth
      }
    }
    return null
  }
}

// ---- 闸机记录合并与冲突识别 ----------------------------------------------
// 物理档案（闸机档）与来源 gates 索引分别标注来源；同标识同内容为重复投递，
// 同标识不同内容为冲突；同一放行位重复登记但内容不一致也算冲突。
const gateIdentity = gate => `${gate.house}|${gate.room}|${gate.day}|${gate.at}|${gate.voucher}`

export function mergeGateRecords(sourced, archived) {
  const byIdentity = new Map()
  const conflicts = []
  const visit = (gate, origin) => {
    const key = gateIdentity(gate)
    const tagged = { ...gate, origin }
    const existing = byIdentity.get(key)
    if (!existing) {
      byIdentity.set(key, { ...tagged, copies: [origin] })
      return
    }
    if (existing.allowed !== gate.allowed || existing.show !== gate.show) {
      conflicts.push({ key, origins: [...existing.copies, origin], reason: '同一放行记录内容冲突' })
    } else if (!existing.copies.includes(origin)) {
      existing.copies.push(origin)
    }
  }
  for (const gate of sourced) visit(gate, 'source-index')
  for (const gate of archived) visit(gate, 'physical-archive')
  return { records: [...byIdentity.values()], conflicts }
}

// 物理档之间（含重复投递的范围相交副本）按 device/gen/seq 比对。
export function detectArchiveConflicts(bundles) {
  const conflicts = []
  const seen = new Map()
  for (const bundle of bundles) {
    for (const record of bundle.records) {
      const key = `${record.device}|${record.gen}|${record.seq}`
      const signature = JSON.stringify([record.at, record.show, record.voucher, record.allowed])
      const previous = seen.get(key)
      if (previous && previous.signature !== signature) {
        conflicts.push({ key, reason: '重复投递档案对同一放行位给出不同内容', origins: [previous.bundle, bundle.id] })
      } else if (!previous) {
        seen.set(key, { signature, bundle: bundle.id })
      }
    }
  }
  return conflicts
}

// ---- 单场实到核算 --------------------------------------------------------
// 先判实际放行（allowed 且落在场次窗口、影厅一致），再判适用单场权益
// （券在扫码时刻归属的权益其适用场等于本场），最后按票包去重。
export function reconcileEvent(event, context) {
  const { resolveVoucher, gateRecords, segments, archiveConflicts } = context
  const admissions = []
  const rejected = []
  for (const gate of gateRecords) {
    if (gate.house !== event.house || gate.room !== event.room || gate.show !== event.show) continue
    const inWindow = gate.at >= event.from && gate.at < event.until
    const classification = classifyGate(gate, event, inWindow, resolveVoucher)
    if (classification.admitted) admissions.push({ ...gate, ...classification })
    else rejected.push({ ...gate, ...classification })
  }
  const passPackages = new Map()
  for (const admission of admissions) {
    if (!passPackages.has(admission.pass)) {
      passPackages.set(admission.pass, {
        pass: admission.pass, entitlements: new Set(), vouchers: new Set(), scans: []
      })
    }
    const group = passPackages.get(admission.pass)
    group.entitlements.add(admission.entitlement)
    group.vouchers.add(admission.voucher)
    group.scans.push({ at: admission.at, voucher: admission.voucher, entitlement: admission.entitlement, origins: admission.copies })
  }
  const audience = [...passPackages.values()].map(group => ({
    pass: group.pass,
    entitlements: [...group.entitlements].sort(),
    vouchers: [...group.vouchers].sort(),
    scans: group.scans.sort((a, b) => a.at - b.at)
  }))
  const status = decideStatus(event, segments, archiveConflicts, admissions, rejected)
  return {
    show: event.show,
    status,
    // 实到人数只在没有冲突的前提下给出；缺尾/断档时标注为暂计而非零人。
    provisionalAudience: status.kind === 'conflict' ? null : audience.length,
    audience,
    admissions,
    rejected,
    segments: segments.map(segment => ({ ...segment })),
    conflicts: [...archiveConflicts, ...collectSegmentConflicts(segments)]
  }
}

function classifyGate(gate, event, inWindow, resolveVoucher) {
  if (!inWindow) return { admitted: false, reason: '扫码不在场次放行窗口（夜场跨午夜按累计分钟判定）' }
  if (!gate.allowed) return { admitted: false, reason: '闸机未放行' }
  const resolved = resolveVoucher(gate.voucher, gate.at)
  if (!resolved) return { admitted: false, reason: '券号不属于任何当期票包权益' }
  if (resolved.status === 'stale-voucher') {
    return { admitted: false, reason: '换场生效后仍出示旧券，该权益已转至新券', pass: resolved.pass, entitlement: resolved.entitlement }
  }
  if (resolved.show !== event.show) {
    return {
      admitted: false, reason: `券在此时刻归属的权益适用场为 ${resolved.show}，非本场`,
      pass: resolved.pass, entitlement: resolved.entitlement
    }
  }
  return { admitted: true, reason: '有效放行且适用本场权益', pass: resolved.pass, entitlement: resolved.entitlement }
}

function decideStatus(event, segments, archiveConflicts, admissions, rejected) {
  if (archiveConflicts.length || segments.some(segment => segment.conflicts.length)) {
    return { kind: 'conflict', reason: '存在放行冲突，未经授权的重复入场不能计为第二位观众，需人工核对原件' }
  }
  const broken = segments.filter(segment => segment.kind === 'gap' || segment.kind === 'unsealed')
  if (broken.length) {
    return {
      kind: 'evidence-incomplete',
      reason: '档案缺尾或断档，现有放行可暂计但不能封账',
      blocking: broken.map(({ house, room, day, kind, reasons }) => ({ house, room, day, kind, reasons }))
    }
  }
  if (!segments.length) {
    return { kind: 'evidence-incomplete', reason: '尚未请求到任何覆盖本场的闸机档案', blocking: [] }
  }
  return { kind: 'sealed-evidence', reason: '所涉自然日档案均已封尾且序号连续，实到可封' }
}

function collectSegmentConflicts(segments) {
  const all = []
  for (const segment of segments) all.push(...segment.conflicts)
  return all
}

// ---- 分段（house/room/自然日）封尾判定 -----------------------------------
// 闸机档跟自然日走、影院结账跟营业日走：一个夜场可横跨多个自然日分段。
export function buildSegments(event, context) {
  const { sourceFiles, archiveIndices, archiveBundles, gateRecords } = context
  const days = event.days
  return days.map(day => {
    const files = sourceFiles.filter(f => f.house === event.house && f.room === event.room && f.day === day)
    const indices = archiveIndices.filter(a => a.house === event.house && a.room === event.room && Number(a.day) === day)
    const bundles = archiveBundles.filter(bundle =>
      bundle.house === event.house && bundle.room === event.room && bundle.day === day)
    const conflicts = detectArchiveConflicts(bundles)
    const reasons = []
    let kind = 'sealed'

    if (indices.length) {
      const open = indices.filter(index => index.end === false)
      const seqs = new Set()
      for (const bundle of bundles) for (const record of bundle.records) seqs.add(record.seq)
      for (const index of indices) {
        if (index.end === false) reasons.push(`物理档 ${index.path} 已上传但未封尾`)
        const [first, last] = index.range
        for (let seq = first; seq <= last; seq += 1) {
          if (!seqs.has(seq)) reasons.push(`物理档 ${index.path} 断档：缺少放行位 ${seq}`)
        }
      }
      // 没有任何原因时保持 sealed；断档比单纯未封尾更严重，同时存在时按 gap 处理。
      if (reasons.length) {
        kind = reasons.some(r => r.startsWith('物理档') && r.includes('断档')) ? 'gap' : 'unsealed'
      }
    } else if (files.length) {
      // 物理档尚未投来时，来源 files 是上一班的封尾索引；complete=0 即缺尾。
      const complete = files.some(f => f.complete)
      if (!complete) {
        kind = 'unsealed'
        reasons.push('来源档案索引未封尾，且尚无物理档可核对')
      }
    } else {
      kind = 'gap'
      reasons.push(`自然日 ${day} 没有任何档案登记，无法证明该段放行`)
    }

    // 物理档与来源 gates 索引交叉核对：同标识冲突已在 mergeGateRecords 收集，
    // 这里只核对来源索引里有、物理档里缺失的放行（反向缺失按断档处理）。
    const covered = gateRecords.some(g =>
      g.house === event.house && g.room === event.room && g.day === day && g.copies.includes('physical-archive'))
    if (bundles.length && covered === false && gateRecords.some(g => g.house === event.house && g.room === event.room && g.day === day)) {
      kind = 'gap'
      reasons.push('来源 gates 索引中的放行未出现在任何物理档内')
    }
    return { house: event.house, room: event.room, day, kind, reasons, conflicts }
  })
}
