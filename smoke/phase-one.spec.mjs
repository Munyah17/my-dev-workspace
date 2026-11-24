import { expect, test, devices } from '@playwright/test'

test('PWA shell and mobile-to-desktop ticket flow', async ({ browser, page }) => {
  const baseURL = 'http://127.0.0.1:4173'
  const phone = await browser.newContext({ ...devices['Pixel 7'], baseURL })
  const second = await browser.newContext({ baseURL })
  try {
    const mobile = await phone.newPage()
    await mobile.goto('/')
    const manifestUrl = await mobile.locator('link[rel=manifest]').getAttribute('href')
    const manifest = await (await mobile.request.get(manifestUrl)).json()
    expect(manifest.display).toBe('standalone')
    for (const icon of manifest.icons) expect((await mobile.request.get(icon.src)).ok()).toBeTruthy()
    await expect.poll(() => mobile.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated')
    await mobile.getByRole('button', { name: 'The Gents' }).click()
    await mobile.getByRole('link', { name: 'Report an issue' }).click()
    const subject = 'Missing staff record ' + Date.now()
    const report = 'I added a barber, but the record disappears after I reload.'
    await mobile.getByLabel('Project').selectOption('gents-staff')
    await mobile.getByLabel('Subject').fill(subject)
    await mobile.getByLabel('Message').fill(report)
    await mobile.getByLabel(/Attachment/).setInputFiles({ name: 'report.txt', mimeType: 'text/plain', buffer: Buffer.from('Staging fixture') })
    await mobile.getByRole('button', { name: 'Send report' }).click()
    await expect(mobile.getByText(report)).toBeVisible()
    expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy()
    const link = mobile.url()
    const attachment = await mobile.getByRole('link', { name: 'report.txt' }).getAttribute('href')
    await page.goto('/')
    await page.getByRole('button', { name: 'Agency' }).click()
    await page.getByRole('link', { name: new RegExp(subject) }).click()
    await expect(page.getByText(report)).toBeVisible()
    const reply = 'We will confirm whether the staff record persists after a reload.'
    await page.getByLabel('Reply', { exact: true }).fill(reply)
    await page.getByRole('button', { name: 'Send reply' }).click()
    await expect(mobile.getByText(reply)).toBeVisible()
    await mobile.getByRole('button', { name: 'Sign out' }).click()
    await mobile.getByRole('button', { name: 'The Gents' }).click()
    await expect(mobile.getByText(reply)).toBeVisible()
    await mobile.reload()
    await expect(mobile.getByText(reply)).toBeVisible()
    const other = await second.newPage()
    await other.goto(link)
    await other.getByRole('button', { name: 'Harbor Studio' }).click()
    await expect(other.getByText('Ticket not found.')).toBeVisible()
    expect((await other.request.get(attachment)).status()).toBe(404)
  } finally {
    await Promise.all([phone.close(), second.close()])
  }
})
