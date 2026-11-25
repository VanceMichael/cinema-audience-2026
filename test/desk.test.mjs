import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { Desk } from '../app/reconcile.mjs'

async function listen(serverFactory) {
  const server = serverFactory().listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, root: 'http://127.0.0.1:' + server.address().port }
}

async function newDesk(t) {
  const source = await listen(createSource)
  const gate = await listen(provider)
  t.after(() => Promise.all([
    new Promise(resolve => source.server.close(resolve)),
    new Promise(resolve => gate.server.close(resolve))
  ]))
  const dir = await mkdtemp(join(tmpdir(), 'desk-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const desk = await new Desk({
    sourceRoot: source.root, providerRoot: gate.root,
    statePath: join(dir, 'desk.json'), archiveDir: join(dir, 'archives')
  }).init()
  const post = async (root, path) => (await fetch(root + path, { method: 'POST' })).json()
  return { desk, sourceRoot: source.root, providerRoot: gate.root, post }
}

test('完整演练：先封资料齐的场次，晚到换场只改凭据不扣人，新店封尾后再作结账决定', async t => {
  const { desk, sourceRoot, providerRoot, post } = await newDesk(t)

  // ---- r1 首期资料 -------------------------------------------------------
  await post(sourceRoot, '/control?edition=r1')
  await post(providerRoot, '/lab?stage=first-house')
  const ingested = await desk.ingest('r1')
  assert.equal(ingested.edition, 'r1')
  assert.equal(ingested.counts.events, 3)

  // A 场请档：物理档与来源索引交叉核对。
  const bundles = await desk.requestArchives('A')
  assert.equal(bundles.length, 1)
  assert.equal(bundles[0].archive.end, true)

  // 同票包 P 用 E1(q1) 与 E4(q5) 两项权益进同场，只算一个独立观众；加上 J 共 2 人。
  const first = desk.reconcile('A')
  assert.equal(first.status.kind, 'sealed-evidence')
  assert.equal(first.provisionalAudience, 2)
  assert.deepEqual(first.audience.map(a => a.pass).sort(), ['J', 'P'])

  // B 场档案未封尾：绝不能按零人封账。
  const pendingB = desk.reconcile('B')
  assert.equal(pendingB.status.kind, 'evidence-incomplete')
  await assert.rejects(() => desk.seal('B'), /不能封账/)

  // 资料齐的 A 先封。
  const sealedA = await desk.seal('A')
  assert.equal(sealedA.audience, 2)

  // ---- r2：换场回执晚到 --------------------------------------------------
  await post(sourceRoot, '/control?edition=r2')
  await post(providerRoot, '/lab?stage=late-exchange')
  await desk.ingest('r2')

  // 旧场 A：E1 的旧券 q1 已失效，但同票包 E4(q5) 仍是有效到场，独立观众数不变。
  const rechecked = desk.reconcile('A')
  assert.equal(rechecked.provisionalAudience, 2)
  assert.ok(rechecked.rejected.some(r => r.voucher === 'q1' && /旧券/.test(r.reason)))
  const pGroup = rechecked.audience.find(a => a.pass === 'P')
  assert.deepEqual(pGroup.entitlements, ['E4'])

  // 已付旧账写更正：delta 必须为 0，只修订凭据；合作台 202 受理待确认。
  const amendment = await desk.amend({ show: 'A', line: 'f1' })
  assert.equal(amendment.status, 202)
  assert.equal(amendment.amendment.audienceDelta, 0)
  assert.deepEqual(amendment.amendment.deltaByEntitlement.removed, ['E1'])
  assert.deepEqual(amendment.amendment.deltaByEntitlement.retained.sort(), ['E3', 'E4'])
  assert.equal(amendment.amendment.state, 'received')

  // 新场 B：物理档已到但未封尾，两次 q4 扫码只对应 P 一个观众（暂计，不可封）。
  await desk.requestArchives('B')
  const provisionalB = desk.reconcile('B')
  assert.equal(provisionalB.status.kind, 'evidence-incomplete')
  assert.equal(provisionalB.provisionalAudience, 1)
  assert.equal(provisionalB.audience[0].scans.length, 2)
  await assert.rejects(() => desk.seal('B'), /不能封账/)

  // 合作台允许一边先接更正、另一边因当天未封拒绝：预提后收到 409，继续等待、挂账不抵清。
  const refused = await desk.amend({ show: 'B', line: 'f4', provisional: true })
  assert.equal(refused.status, 409)
  assert.equal(refused.amendment.state, 'waiting-period')

  // ---- 新店封尾 ----------------------------------------------------------
  await post(providerRoot, '/lab?stage=other-house')
  const redelivered = await desk.requestArchives('B')
  assert.equal(redelivered[0].archive.end, true)
  // 旧的未封尾登记被取代但原件保留，磁盘上有两份档案。
  const nowSealed = desk.reconcile('B')
  assert.equal(nowSealed.status.kind, 'sealed-evidence')
  assert.equal(nowSealed.provisionalAudience, 1)
  const sealedB = await desk.seal('B')
  assert.equal(sealedB.audience, 1)

  // 新场按其有证的实到重新作出结账决定：202，且不与旧场任何差额抵清。
  const decision = await desk.amend({ show: 'B', line: 'f4' })
  assert.equal(decision.status, 202)
  assert.equal(decision.amendment.audienceDelta, 1)
  assert.equal(decision.amendment.state, 'received')

  // 回执：旧场更正已确认，新场账行新建。
  const receipts = await desk.refreshReceipts()
  assert.equal(receipts.find(r => r.line === 'f1').state, 'confirmed')
  assert.ok(receipts.some(r => r.show === 'B' && r.line === 'f4'))
})

test('按影院查场次进度、按票包追每场凭据与待补分段', async t => {
  const { desk, sourceRoot, providerRoot, post } = await newDesk(t)
  await post(sourceRoot, '/control?edition=r2')
  await post(providerRoot, '/lab?stage=late-exchange')
  await desk.ingest('r2')
  await desk.requestArchives('A')

  const houseC = desk.houseReport('C')
  assert.deepEqual(houseC.map(s => s.show), ['A'])
  assert.equal(houseC[0].ledgerLines[0].line, 'f1')
  assert.ok(houseC[0].window.days.includes(1))

  const passP = desk.passReport('P')
  assert.deepEqual(passP.entitlements.map(e => e.entitlement).sort(), ['E1', 'E2', 'E4'])
  const atA = passP.perShow.find(s => s.show === 'A')
  assert.ok(atA)
  // B 场未请档前，票包追踪要能指出还缺哪段档案。
  await desk.requestArchives('B')
  const passPAfter = desk.passReport('P')
  const atB = passPAfter.perShow.find(s => s.show === 'B')
  assert.equal(atB.counted, true)
  assert.ok(atB.missingSegments.some(m => m.day === 2 && m.kind === 'unsealed'))

  assert.throws(() => desk.passReport('NO-SUCH-PACKAGE'), /没有票包/)
})

test('资料版隔离：r1 没有 exchange 流时领取不报错，切换后才出现换场', async t => {
  const { desk, sourceRoot, post } = await newDesk(t)
  await post(sourceRoot, '/control?edition=r1')
  const r1 = await desk.ingest('r1')
  assert.equal(r1.counts.exchange, 0)
  assert.equal(desk.domain().exchanges.length, 0)
  await post(sourceRoot, '/control?edition=r2')
  await desk.ingest('r2')
  assert.equal(desk.domain().exchanges.length, 1)
  // r1 的历史记录在合并后仍然保留。
  assert.equal(desk.domain().passes.length, 4)
})
