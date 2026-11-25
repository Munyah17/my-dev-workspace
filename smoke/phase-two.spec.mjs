import { expect, test, devices } from '@playwright/test'

test('agency adds and queues a monitor while another client sees no monitoring records', async ({ browser, page }) => {
  const name = 'Homepage check ' + Date.now()
  await page.goto('/')
  await page.getByRole('button', { name: 'Agency' }).click()
  await page.getByRole('link', { name: 'Apps' }).click()
  await page.getByRole('button', { name: 'Add monitor' }).click()
  await page.getByRole('combobox', { name: 'App', exact: true }).selectOption('gents-staff')
  await page.getByLabel('Monitor name').fill(name)
  await page.getByLabel('Public HTTPS URL').fill('https://gents-fixture.example.test')
  await page.getByRole('button', { name: 'Save monitor' }).click()
  await expect(page.getByRole('button', { name: 'Run now' })).toBeEnabled()
  const monitorId = new URL(page.url()).hash.split('/').at(-1)
  await page.getByRole('button', { name: 'Run now' }).click()
  await expect(page.getByText('queued', { exact: true }).last()).toBeVisible()
  await page.getByRole('link', { name: 'Today', exact: true }).click()
  await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveAttribute('href', '#apps/' + monitorId)
  const phone = await browser.newContext({ ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:4173' })
  try {
    const client = await phone.newPage()
    await client.goto('/#apps/' + monitorId)
    await client.getByRole('button', { name: 'Harbor Studio' }).click()
    await expect(client.getByText('Page not found.', { exact: true })).toBeVisible()
    await expect(client.getByRole('link', { name: 'Apps' })).toHaveCount(0)
    expect((await client.request.get('/api/monitoring/monitor/' + monitorId)).status()).toBe(404)
  } finally {
    await phone.close()
  }
})
