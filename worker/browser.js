import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { chromium } from 'playwright'
import { monitorUrl, publicAddress } from './network.js'

async function proxyFor(origin) {
  const sockets = new Set()
  const proxy = createServer((_request, response) => response.writeHead(403).end())
  proxy.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  })
  proxy.on('connect', async (request, client, head) => {
    try {
      const target = new URL('https://' + request.url)
      if (target.origin !== origin || target.username || target.password || target.pathname !== '/') throw new Error()
      const { address, family } = await publicAddress(target.hostname)
      if (client.destroyed) return
      const upstream = connect({ host: address, port: 443, family })
      sockets.add(upstream)
      upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
      upstream.on('error', () => upstream.destroy())
      client.on('close', () => upstream.destroy())
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    }
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  return {
    url: 'http://127.0.0.1:' + proxy.address().port,
    close() {
      for (const socket of sockets) socket.destroy()
      proxy.close()
    },
  }
}

function containsField(body, expected) {
  if (body == null) return false
  if (typeof body === 'object') return Object.values(body).some(value => containsField(value, expected))
  return String(body) === expected
}

function writeAllowed(request, workflow, production, cleaning) {
  if (['GET','HEAD','OPTIONS'].includes(request.method())) return true
  if (!workflow.writes) return false
  if (!production) return true
  const path = new URL(request.url()).pathname
  let payload
  try { payload = request.postDataJSON() } catch { return false }
  if (production.signInPaths.includes(path)) return containsField(payload, production.values.TEST_ACCOUNT)
  return (cleaning ? production.cleanupPaths : production.writePaths).includes(path)
    && containsField(payload, production.values.TEST_RECORD)
}

export async function browserCheck(monitor, workflow, { createProxy = proxyFor, browserType = chromium, recordSteps = false } = {}) {
  if (!workflow) return { outcome: 'monitor_error', actual: 'No workflow is configured.' }
  const base = monitorUrl(monitor.url)
  const productionWrite = workflow.writes && monitor.environment === 'Production'
  const secretKey = [
    'MONITOR_SECRET',
    Buffer.from(monitor.project_id).toString('hex').toUpperCase(),
    monitor.environment.toUpperCase(),
    workflow.secret_name,
  ].join('_')
  const allSteps = [...workflow.steps, ...workflow.cleanup]
  let config, secrets
  try {
    config = workflow.secret_name ? JSON.parse(process.env[secretKey] ?? 'null') : { values: {} }
    if (!config || (workflow.secret_name && monitorUrl(config.origin).origin !== base.origin)) throw new Error()
    secrets = config.values
    if (!secrets || typeof secrets !== 'object') throw new Error()
    for (const step of allSteps) if (step.secret && typeof secrets[step.secret] !== 'string') throw new Error()
    if (productionWrite && (
      !workflow.cleanup.length || workflow.cleanup.at(-1).action !== 'assert' ||
      !secrets.TEST_ACCOUNT || !secrets.TEST_RECORD ||
      !allSteps.some(step => step.secret === 'TEST_ACCOUNT') ||
      !workflow.steps.some(step => step.secret === 'TEST_RECORD') ||
      !workflow.cleanup.some(step => step.secret === 'TEST_RECORD') ||
      !['signInPaths','writePaths','cleanupPaths'].every(field =>
        Array.isArray(config[field]) && config[field].length && config[field].every(path =>
          typeof path === 'string' && path.startsWith('/') && !path.includes('*')))
    )) throw new Error()
  } catch {
    return { outcome: 'monitor_error', actual: 'The workflow secret, origin, test scope, or cleanup configuration is missing or invalid.' }
  }

  const proxy = await createProxy(base.origin)
  let browser, context, page, current, cleaning = false, wrote = false
  const deadline = Date.now() + monitor.timeout_seconds * 1000
  const cleanupReserve = workflow.cleanup.length ? Math.floor(monitor.timeout_seconds * 1000 / 3) : 0
  const remaining = () => Math.max(1, deadline - Date.now() - (cleaning ? 0 : cleanupReserve))
  const session = async () => {
    await context?.close()
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false })
    await context.route('**/*', route => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.origin !== base.origin || !writeAllowed(req, workflow, productionWrite && config, cleaning)) return route.abort()
      if (!current?.credential && !['GET','HEAD','OPTIONS'].includes(req.method())) wrote = true
      return route.continue()
    })
    await context.routeWebSocket('**/*', socket => socket.close())
    page = await context.newPage()
  }
  const trace = []
  const checkSteps = async steps => {
    for (const step of steps) {
      current = step
      const options = { timeout: remaining() }
      if (step.action === 'navigate') {
        const url = monitorUrl(new URL(step.path, base).href)
        if (url.origin !== base.origin) return { outcome: 'monitor_error', actual: 'Navigation left the monitor origin.' }
        const response = await page.goto(url.href, { ...options, waitUntil: 'domcontentloaded' })
        if (response?.status() === 401 || response?.status() === 403) {
          return { outcome: 'monitor_error', step: step.label, actual: 'The application rejected the test credentials.' }
        }
        if (response?.status() >= 400) return { outcome: 'failure', step: step.label, expected: 'Page loads', actual: 'HTTP ' + response.status() }
      }
      if (step.action === 'fill') await page.locator(step.selector).fill(step.secret ? secrets[step.secret] : step.value, options)
      if (step.action === 'click') await page.locator(step.selector).click(options)
      if (step.action === 'assert') await page.locator(step.selector).filter({ hasText: step.value }).waitFor(options)
      if (step.action === 'fresh') await session()
      if (recordSteps) trace.push({ step:step.label,outcome:'pass' })
    }
    return { outcome: 'pass', actual: 'All workflow steps passed.' }
  }
  try {
    browser = await browserType.launch({
      timeout: remaining(), proxy: { server: proxy.url },
      args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    })
    await session()
    let result
    try {
      result = await checkSteps(workflow.steps)
    } catch (error) {
      if (!browser.isConnected() || !current) {
        result = { outcome: 'monitor_error', actual: 'The browser runner could not complete the job.' }
      } else {
        result = {
          outcome: current.action === 'assert' && !current.credential && error.name === 'TimeoutError' ? 'failure' : 'monitor_error',
          step: current.label,
          expected: current.action === 'assert' ? 'Configured text is visible' : 'Step completes',
          actual: current.credential ? 'Test sign-in could not be confirmed.' : error.name === 'TimeoutError' ? 'Expected result was not observed before timeout.' : 'The step could not be completed.',
        }
      }
    }
    if (recordSteps && result.outcome !== 'pass' && result.step) trace.push({ step:result.step,outcome:result.outcome })
    if (workflow.cleanup.length && wrote) {
      cleaning = true
      const cleanup = await checkSteps(workflow.cleanup).catch(() => null)
      if (cleanup?.outcome !== 'pass') return { outcome: 'monitor_error', actual: 'Cleanup could not be verified. Check the test records.' }
    }
    return recordSteps ? { ...result,checks:trace } : result
  } catch {
    return { outcome: 'monitor_error', actual: 'The browser runner could not start a test session.' }
  } finally {
    proxy.close()
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}
