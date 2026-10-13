import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sidecarUrl } from './proxy.mjs'

const BASE = 'http://172.17.0.1:8792'

test('joins plain segments under the prefix and keeps the query', () => {
  assert.equal(sidecarUrl(BASE, '/root/', ['agents']).href, `${BASE}/root/agents`)
  assert.equal(
    sidecarUrl(BASE, '/root/', ['inbox', 'agent-fern'], '?limit=5').href,
    `${BASE}/root/inbox/agent-fern?limit=5`,
  )
  assert.equal(sidecarUrl(BASE, '/gateway/', ['noti', 'pump']).href, `${BASE}/gateway/noti/pump`)
})

test('keeps a percent-encoded name encoded rather than decoding it into a path', () => {
  assert.equal(sidecarUrl(BASE, '/root/', ['inbox', 'a%2Fb']).pathname, '/root/inbox/a%2Fb')
})

test('refuses dot segments and anything that is not a plain name', () => {
  for (const seg of [['..', 'gateway', 'send'], ['.'], ['a b'], ['a\\b'], ['a?b'], ['a#b'], ['a:b'], ['@evil'], ['']]) {
    assert.throws(() => sidecarUrl(BASE, '/root/', seg), { code: 400 }, JSON.stringify(seg))
  }
})

test('never leaves the sidecar origin, whatever the base path is', () => {
  const t = sidecarUrl('http://sidecar:9/some/base', '/gateway/', ['status'])
  assert.equal(t.origin, 'http://sidecar:9')
  assert.equal(t.pathname, '/gateway/status')
})
