import assert from 'node:assert/strict'
import test from 'node:test'
import { monitorUrl, publicAddress } from './network.js'

test('monitor destinations reject local, credential-bearing or non-HTTPS URLs and mixed DNS results', async () => {
  for (const input of ['http://example.com','https://localhost','https://u:p@example.com','https://example.com:444','https://example.com/#fragment']) {
    assert.throws(() => monitorUrl(input))
  }
  for (const address of ['127.0.0.1','169.254.169.254','10.0.0.1','100.64.0.1','::ffff:192.168.0.1','fc00::1','fe80::1']) {
    await assert.rejects(publicAddress('example.com', async () => [
      { address:'93.184.216.34',family:4 },{ address,family:address.includes(':') ? 6 : 4 },
    ]))
  }
  assert.equal((await publicAddress('example.com', async () => [{ address:'93.184.216.34',family:4 }])).address,'93.184.216.34')
})
