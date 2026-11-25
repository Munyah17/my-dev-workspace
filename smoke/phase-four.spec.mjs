import { expect,test } from '@playwright/test'

test('agency issues an invoice and the authorized client can open it',async ({ page,browser })=>{
  await page.goto('/')
  await page.getByRole('button',{ name:'Agency' }).click()
  await page.getByRole('link',{ name:'Billing',exact:true }).click()
  await page.getByRole('button',{ name:'New billing document' }).click()
  await page.getByRole('combobox',{ name:'Client',exact:true }).selectOption('gents')
  await page.getByRole('combobox',{ name:'Document type' }).selectOption('invoice')
  const due=new Date(Date.now()+10*86400000).toISOString().slice(0,10)
  await page.getByLabel('Due or expiry date').fill(due)
  const description='Hosting service '+Date.now()
  await page.getByLabel('Description').fill(description)
  await page.getByLabel('Unit price').fill('50')
  await page.getByRole('button',{ name:'Save draft' }).click()
  await page.getByRole('button',{ name:'Issue invoice' }).click()
  await expect(page.getByText(/^Invoice \d+ · issued$/)).toBeVisible()
  const invoice=page.url()
  const client=await browser.newPage()
  try {
    await client.goto(invoice)
    await client.getByRole('button',{ name:'The Gents' }).click()
    await expect(client.getByText(description,{exact:true})).toBeVisible()
    await expect(client.getByText('Record manual payment')).toHaveCount(0)
  } finally {
    await client.close()
  }
})
