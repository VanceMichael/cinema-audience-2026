import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

import { gunzipSync } from 'node:zlib'
test('新厅闸机档先到但未封，不能替换另一影院的账台事实', async t => {
  const root = await listen(t)
  await post(root, '/lab?stage=late-exchange')
  const archives = await (await fetch(root + '/gates/archives?house=D&date=2')).json()
  assert.equal(archives[0].end, false)
  const compressed = Buffer.from(await (await fetch(root + archives[0].path)).arrayBuffer())
  assert.equal(JSON.parse(gunzipSync(compressed).toString().split('\n')[0]).at, 1455)
  assert.equal((await post(root, '/settlement/amend', { show: 'A', line: 'f1' })).status, 202)
  assert.equal((await post(root, '/settlement/amend', { show: 'B' })).status, 409)
  await post(root, '/lab?stage=other-house')
  assert.equal((await (await fetch(root + '/settlement/receipts')).json())[0].state, 'confirmed')
})
