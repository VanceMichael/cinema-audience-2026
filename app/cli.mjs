#!/usr/bin/env node
// 值班台命令行。示例：
//   node app/cli.mjs ingest r2
//   node app/cli.mjs archives A
//   node app/cli.mjs reconcile A
//   node app/cli.mjs seal A
//   node app/cli.mjs amend A --line f1
//   node app/cli.mjs receipts
//   node app/cli.mjs house C
//   node app/cli.mjs pass P

import { resolve } from 'node:path'
import { Desk } from './reconcile.mjs'

const STATE_DIR = process.env.STATE_DIR || resolve('state')
const desk = await new Desk({
  sourceRoot: process.env.SOURCE_URL || 'http://127.0.0.1:8700',
  providerRoot: process.env.PROVIDER_URL || 'http://127.0.0.1:8701',
  statePath: resolve(STATE_DIR, 'desk.json'),
  archiveDir: resolve(STATE_DIR, 'archives')
}).init()

const [command, ...rest] = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = rest.indexOf(name)
  return index >= 0 ? rest[index + 1] : fallback
}

function print(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function fail(error) {
  process.stdout.write(JSON.stringify({
    ok: false, error: error.message, code: error.code || null, detail: error.detail || null
  }, null, 2) + '\n')
  process.exitCode = 1
}

try {
  switch (command) {
    case 'ingest': {
      print({ ok: true, ...await desk.ingest(rest[0]) })
      break
    }
    case 'archives': {
      const show = rest[0]
      const bundles = await desk.requestArchives(show)
      print({
        ok: true, show,
        requested: desk.requiredArchives(show),
        downloaded: bundles.map(b => ({
          path: b.archive.path, range: b.archive.range, end: b.archive.end, diskPath: b.diskPath, etag: b.etag
        }))
      })
      break
    }
    case 'reconcile': {
      print({ ok: true, ...stripInternals(desk.reconcile(rest[0])) })
      break
    }
    case 'seal': {
      print({ ok: true, sealed: await desk.seal(rest[0]) })
      break
    }
    case 'amend': {
      const show = rest[0]
      const line = option('--line')
      const note = option('--note', '')
      const provisional = rest.includes('--provisional')
      if (!line) throw new Error('amend 需要 --line <账行>')
      print({ ok: true, ...await desk.amend({ show, line, extra: { note }, provisional }) })
      break
    }
    case 'receipts': {
      print({ ok: true, receipts: await desk.refreshReceipts() })
      break
    }
    case 'ledger': {
      print({ ok: true, lines: await desk.refreshLedger() })
      break
    }
    case 'house': {
      print({ ok: true, house: rest[0], shows: desk.houseReport(rest[0]) })
      break
    }
    case 'pass': {
      print({ ok: true, ...desk.passReport(rest[0]) })
      break
    }
    case 'status': {
      print({
        ok: true,
        editions: desk.store.state.editions,
        sealed: Object.keys(desk.store.state.sealed),
        amendments: desk.store.state.amendments.map(a => ({
          show: a.show, line: a.line, state: a.state, audienceDelta: a.audienceDelta
        })),
        archives: desk.store.state.archives.map(a => ({
          house: a.archive.house, day: a.archive.day, path: a.archive.path, end: a.archive.end
        }))
      })
      break
    }
    default:
      process.stdout.write([
        '用法: node app/cli.mjs <命令> [参数]',
        '  ingest [edition]            领取一期来源资料（默认当前版）',
        '  archives <show>             按场次所涉影厅/自然日请求并下载闸机档',
        '  reconcile <show>            核算单场放行、适用权益与独立观众',
        '  seal <show>                 证据齐时封账并留存快照',
        '  amend <show> --line <id>    对已封场账行提交更正（可 --note）',
        '  receipts                    读回合作台回执',
        '  ledger                      读回合作台账期与账行',
        '  house <house>               按影院查场次、进度与账行',
        '  pass <pass>                 按票包追每场凭据与缺失分段',
        '  status                      本地值班总览'
      ].join('\n') + '\n')
  }
} catch (error) {
  fail(error)
}

function stripInternals(result) {
  return {
    show: result.show,
    status: result.status,
    provisionalAudience: result.provisionalAudience,
    sealed: result.sealed ? { sealedAt: result.sealed.sealedAt, audience: result.sealed.audience } : null,
    audience: result.audience.map(a => ({
      pass: a.pass, entitlements: a.entitlements, vouchers: a.vouchers, scans: a.scans
    })),
    admissions: result.admissions.map(a => ({
      at: a.at, voucher: a.voucher, entitlement: a.entitlement, pass: a.pass, origins: a.copies
    })),
    rejected: result.rejected.map(a => ({
      at: a.at, voucher: a.voucher, pass: a.pass || null, reason: a.reason, origins: a.copies
    })),
    segments: result.segments,
    conflicts: result.conflicts,
    ledgerLines: result.ledgerLines
  }
}
