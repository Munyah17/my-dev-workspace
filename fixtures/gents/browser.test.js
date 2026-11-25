import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { chromium } from 'playwright'
import { browserCheck } from '../../worker/browser.js'
import { gentsFixture } from './server.js'

test('Chromium observes lost records, successful recovery and rejected fixture credentials', {
  skip: !process.env.MONITOR_BROWSER_TEST,
}, async () => {
  const fixture = gentsFixture({ password: 'fixture-test-password', controlToken: 'local-control-token', secureCookies: false })
  fixture.listen(0, '127.0.0.1')
  await once(fixture,'listening')
  const address = 'http://127.0.0.1:' + fixture.address().port
  const monitorUrl = 'https://gents-fixture.example.test'
  const secret = 'MONITOR_SECRET_67656E74732D7374616666_STAGING_STAFF_TEST'
  const original = process.env[secret]
  process.env[secret] = JSON.stringify({
    origin: monitorUrl,
    values: { TEST_ACCOUNT: 'mydev-staff-test', TEST_PASSWORD: 'fixture-test-password', TEST_RECORD: 'MyDev Test Barber' },
  })
  const workflow = JSON.parse(await readFile(new URL('./workflow.json', import.meta.url), 'utf8'))
  // Only this test replaces the socket transport. The browser still runs every workflow step.
  const localBrowser = {
    async launch(options) {
      const { proxy, ...launchOptions } = options
      assert.ok(proxy)
      const browser = await chromium.launch({ ...launchOptions, executablePath: process.env.MONITOR_CHROMIUM || undefined })
      const newContext = browser.newContext.bind(browser)
      browser.newContext = async settings => {
        const context = await newContext(settings)
        const route = context.route.bind(context)
        context.route = (pattern, handler) => route(pattern, originalRoute => handler({
          request: () => originalRoute.request(), abort: () => originalRoute.abort(),
          async continue() {
            const url = new URL(originalRoute.request().url())
            const response = await originalRoute.fetch({ url: address + url.pathname + url.search, maxRedirects: 0 })
            await originalRoute.fulfill({ response })
          },
        }))
        return context
      }
      return browser
    },
  }
  const run = () => browserCheck({
    url: monitorUrl, environment: 'Staging', project_id: 'gents-staff', timeout_seconds: 12,
  }, { ...workflow, secret_name: workflow.secretName }, {
    browserType: localBrowser, createProxy: async () => ({ url: 'http://fixture.test', close() {} }),
  })
  const mode = async value => {
    const result = await fetch(address + '/control', { method: 'POST', headers: { Authorization: 'Bearer local-control-token' }, body: new URLSearchParams({ mode: value }) })
    assert.equal(result.status, 200)
  }
  try {
    assert.equal((await fetch(address)).status, 200)
    const lost = await run()
    assert.equal(lost.outcome, 'failure', JSON.stringify(lost))
    assert.equal(lost.step, 'Staff record missing after reload')
    await mode('saved')
    const recovered = await run()
    assert.equal(recovered.outcome, 'pass', JSON.stringify(recovered))
    await mode('expired')
    const expired = await run()
    assert.equal(expired.outcome, 'monitor_error', JSON.stringify(expired))
    assert.match(expired.actual, /sign-in|credential/i)
  } finally {
    if (original === undefined) delete process.env[secret]
    else process.env[secret] = original
    await new Promise(resolve => fixture.close(resolve))
  }
})
