import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEvent, parsePass, parseExchange, parseGate,
  buildVoucherResolver, mergeGateRecords, detectArchiveConflicts,
  buildSegments, reconcileEvent, mergeEditions, naturalDay
} from '../app/model.mjs'

const eventA = parseEvent(['A', 'C', 'H', '1', '1', '1400', '1440'])
const eventB = parseEvent(['B', 'D', 'H', '1', '2', '0', '40'])
const passes = [
  parsePass(['P', 'E1', 'q1', 'A']),
  parsePass(['P', 'E4', 'q5', 'A']),
  parsePass(['J', 'E3', 'q3', 'A']),
  parsePass(['P', 'E2', 'q2', 'C'])
]

test('自然日从 1 编起，跨午夜窗口落在第二个自然日', () => {
  assert.equal(naturalDay(0), 1)
  assert.equal(naturalDay(1439), 1)
  assert.equal(naturalDay(1440), 2)
  assert.deepEqual(eventB.days, [2])
  assert.equal(eventB.from, 1440)
  assert.equal(eventB.until, 1480)
  // 恰好午夜结束的夜场不把次日计入所涉自然日。
  assert.deepEqual(eventA.days, [1])
})

test('换场按扫码现场时刻：生效前旧券有效，生效后旧券失效、新券可追溯回原票包', () => {
  const exchanges = [parseExchange(['E1', 'q1', 'q4', 'B', '1431'])]
  const resolve = buildVoucherResolver(passes, exchanges)
  // 生效点之前，旧券仍按原权益与原场适用。
  assert.equal(resolve('q1', 1430).status, 'active')
  assert.equal(resolve('q1', 1430).show, 'A')
  // 生效点之后旧券变 stale，权益没有丢，只是搬到了新券。
  const stale = resolve('q1', 1435)
  assert.equal(stale.status, 'stale-voucher')
  assert.equal(stale.pass, 'P')
  // 新券不在 passes 表，仍能经 exchange 追回票包 P、权益 E1、适用场 B。
  const moved = resolve('q4', 1455)
  assert.equal(moved.status, 'exchanged-in')
  assert.equal(moved.pass, 'P')
  assert.equal(moved.entitlement, 'E1')
  assert.equal(moved.show, 'B')
  // 新券在生效时刻之前出示不成立。
  assert.equal(resolve('q4', 1430), null)
  // 换场只迁一项权益：同票包的 E4(q5) 完全不受影响。
  assert.equal(resolve('q5', 1436).status, 'active')
  assert.equal(resolve('q5', 1436).entitlement, 'E4')
})

test('同票包两项权益同场多次有效扫码只计一个独立观众', () => {
  const resolve = buildVoucherResolver(passes, [])
  const gates = [
    parseGate(['C', 'H', '1', 'A', '1435', 'q1', '1']),
    parseGate(['C', 'H', '1', 'A', '1436', 'q5', '1']),
    parseGate(['C', 'H', '1', 'A', '1432', 'q3', '1'])
  ]
  const { records } = mergeGateRecords(gates, [])
  const result = reconcileEvent(eventA, {
    resolveVoucher: resolve, gateRecords: records,
    segments: [{ house: 'C', room: 'H', day: 1, kind: 'sealed', reasons: [], conflicts: [] }],
    archiveConflicts: []
  })
  assert.equal(result.provisionalAudience, 2)
  assert.deepEqual(result.audience.map(a => a.pass).sort(), ['J', 'P'])
  const p = result.audience.find(a => a.pass === 'P')
  assert.deepEqual(p.entitlements, ['E1', 'E4'])
  assert.equal(p.scans.length, 2)
})

test('同一券重复有效扫码仍是同一人，未经授权的重复入场不会变第二位观众', () => {
  const exchanges = [parseExchange(['E1', 'q1', 'q4', 'B', '1431'])]
  const resolve = buildVoucherResolver(passes, exchanges)
  const gates = [
    parseGate(['D', 'H', '2', 'B', '1455', 'q4', '1']),
    parseGate(['D', 'H', '2', 'B', '1456', 'q4', '1']),
    // 生效后仍刷旧券：拒绝，不得再算一个人。
    parseGate(['D', 'H', '2', 'B', '1457', 'q1', '1'])
  ]
  const { records } = mergeGateRecords(gates, [])
  const result = reconcileEvent(eventB, {
    resolveVoucher: resolve, gateRecords: records,
    segments: [{ house: 'D', room: 'H', day: 2, kind: 'sealed', reasons: [], conflicts: [] }],
    archiveConflicts: []
  })
  assert.equal(result.provisionalAudience, 1)
  assert.equal(result.audience[0].pass, 'P')
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0].reason, /旧券/)
})

test('未放行、窗口外、权益适用他场、无主券都被拒绝且不把场次变成零人结论', () => {
  const resolve = buildVoucherResolver(passes, [])
  const gates = [
    parseGate(['C', 'H', '1', 'A', '1435', 'q1', '0']),           // 闸机未放行
    parseGate(['C', 'H', '1', 'A', '1399', 'q3', '1']),           // 窗口外
    parseGate(['C', 'H', '1', 'A', '1433', 'q2', '1']),           // q2 适用 C 场
    parseGate(['C', 'H', '1', 'A', '1434', 'q9', '1'])            // 无主券
  ]
  const { records } = mergeGateRecords(gates, [])
  const result = reconcileEvent(eventA, {
    resolveVoucher: resolve, gateRecords: records,
    segments: [{ house: 'C', room: 'H', day: 1, kind: 'sealed', reasons: [], conflicts: [] }],
    archiveConflicts: []
  })
  assert.equal(result.provisionalAudience, 0)
  assert.equal(result.admissions.length, 0)
  assert.equal(result.rejected.length, 4)
  assert.equal(result.status.kind, 'sealed-evidence') // 证据齐时零人也是可封的确定结论
})

test('同标识放行内容不一致判定为冲突，冲突时不给实到数字而非按零人', () => {
  const first = parseGate(['C', 'H', '1', 'A', '1435', 'q1', '1'])
  const second = parseGate(['C', 'H', '1', 'A', '1435', 'q1', '0'])
  const { records, conflicts } = mergeGateRecords([first], [second])
  assert.equal(records.length, 1)
  assert.equal(conflicts.length, 1)
  const resolve = buildVoucherResolver(passes, [])
  const result = reconcileEvent(eventA, {
    resolveVoucher: resolve, gateRecords: records,
    segments: [{ house: 'C', room: 'H', day: 1, kind: 'sealed', reasons: [], conflicts: [] }],
    archiveConflicts: conflicts
  })
  assert.equal(result.status.kind, 'conflict')
  assert.equal(result.provisionalAudience, null)
})

test('范围相交的重复投递档案：同内容相容，不同放行位内容冲突可识别', () => {
  const ok = detectArchiveConflicts([
    { id: 'a', records: [{ device: 'HD', gen: 'B', seq: 9, at: 1455, show: 'B', voucher: 'q4', allowed: true }] },
    { id: 'b', records: [{ device: 'HD', gen: 'B', seq: 9, at: 1455, show: 'B', voucher: 'q4', allowed: true }] }
  ])
  assert.deepEqual(ok, [])
  const bad = detectArchiveConflicts([
    { id: 'a', records: [{ device: 'HD', gen: 'B', seq: 9, at: 1455, show: 'B', voucher: 'q4', allowed: true }] },
    { id: 'b', records: [{ device: 'HD', gen: 'B', seq: 9, at: 1455, show: 'B', voucher: 'q4', allowed: false }] }
  ])
  assert.equal(bad.length, 1)
})

test('分段区分未封尾、断档与完全缺档，且绝不解释成零人', () => {
  const base = {
    sourceFiles: [],
    archiveIndices: [{ house: 'D', room: 'H', day: 2, range: [9, 10], end: false, path: '/gates/new' }],
    archiveBundles: [{ id: 'x', house: 'D', room: 'H', day: 2, records: [{ seq: 9 }, { seq: 10 }] }],
    gateRecords: []
  }
  const unsealed = buildSegments(eventB, base)
  assert.equal(unsealed[0].kind, 'unsealed')

  const gap = buildSegments(eventB, {
    ...base,
    archiveIndices: [{ house: 'D', room: 'H', day: 2, range: [9, 11], end: true, path: '/gates/new' }],
    archiveBundles: [{ id: 'x', house: 'D', room: 'H', day: 2, records: [{ seq: 9 }, { seq: 10 }] }]
  })
  assert.equal(gap[0].kind, 'gap')
  assert.ok(gap[0].reasons.some(r => r.includes('11')))

  const missing = buildSegments(eventB, {
    sourceFiles: [], archiveIndices: [], archiveBundles: [], gateRecords: []
  })
  assert.equal(missing[0].kind, 'gap')
})

test('夜场跨午夜：两个自然日分段都封尾才可封，任一段缺尾都不能按零人封账', () => {
  // 营业日 1 的夜场，允许自然日 1 的 1430 分到自然日 2 的 20 分（累计分钟）。
  const midnight = parseEvent(['N', 'C', 'H', '1', '1', '1430', '1460'])
  assert.deepEqual(midnight.days, [1, 2])
  const nightPasses = [
    parsePass(['P', 'E1', 'q1', 'N']),
    parsePass(['P', 'E4', 'q5', 'N']),
    parsePass(['K', 'E9', 'q9', 'N'])
  ]
  const resolve = buildVoucherResolver(nightPasses, [])
  const gates = [
    parseGate(['C', 'H', '1', 'N', '1435', 'q1', '1']),
    parseGate(['C', 'H', '2', 'N', '1450', 'q5', '1']),
    parseGate(['C', 'H', '2', 'N', '1452', 'q9', '1'])
  ]
  const { records } = mergeGateRecords(gates, [])
  const day1 = { house: 'C', room: 'H', day: 1, kind: 'sealed', reasons: [], conflicts: [] }
  const day2Open = { house: 'C', room: 'H', day: 2, kind: 'unsealed', reasons: ['次日档案未封尾'], conflicts: [] }
  const blocked = reconcileEvent(midnight, {
    resolveVoucher: resolve, gateRecords: records,
    segments: [day1, day2Open], archiveConflicts: []
  })
  // 两段里有一段未封尾：已有两人到场（P、K）可暂计，但状态是证据不齐、禁止封账。
  assert.equal(blocked.status.kind, 'evidence-incomplete')
  assert.equal(blocked.provisionalAudience, 2)
  const ready = reconcileEvent(midnight, {
    resolveVoucher: resolve, gateRecords: records,
    segments: [day1, { ...day2Open, kind: 'sealed', reasons: [] }], archiveConflicts: []
  })
  assert.equal(ready.status.kind, 'sealed-evidence')
  assert.equal(ready.provisionalAudience, 2)
  // 票包 P 跨午夜两段各一次扫码，仍只对应一个独立观众。
  const pGroup = ready.audience.find(a => a.pass === 'P')
  assert.equal(pGroup.scans.length, 2)
  assert.deepEqual(pGroup.entitlements.sort(), ['E1', 'E4'])
})

test('多资料版合并：后继版新增换场与闸机，原票包与历史放行继续保留', () => {  const merged = mergeEditions([
    {
      edition: 'r1',
      streams: {
        events: [['A', 'C', 'H', '1', '1', '1400', '1440']],
        passes: [['P', 'E1', 'q1', 'A']], exchange: [],
        gates: [['C', 'H', '1', 'A', '1435', 'q1', '1']], files: [], closed: []
      }
    },
    {
      edition: 'r2',
      streams: {
        events: [], passes: [],
        exchange: [['E1', 'q1', 'q4', 'B', '1431']],
        gates: [['D', 'H', '2', 'B', '1455', 'q4', '1']], files: [], closed: []
      }
    }
  ])
  assert.equal(merged.passes.length, 1)
  assert.equal(merged.exchanges.length, 1)
  assert.equal(merged.gates.length, 2)
  assert.equal(merged.events.length, 1)
})
