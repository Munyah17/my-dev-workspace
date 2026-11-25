import { expect,test } from '@playwright/test'

test('agency creates a standalone task and reviews the same record from Due soon',async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button',{ name:'Agency' }).click()
  await page.getByRole('link',{ name:'Tasks',exact:true }).click()
  await page.getByRole('button',{ name:'New task' }).click()
  await page.getByRole('combobox',{ name:'Workspace' }).selectOption('demo')
  const name = 'Renew domain ' + Date.now()
  await page.getByRole('textbox',{ name:'Task name' }).fill(name)
  await page.getByRole('combobox',{ name:'Assignee' }).selectOption('agency')
  const tomorrow = new Date(Date.now()+86400000)
  const local = new Date(tomorrow.getTime()-tomorrow.getTimezoneOffset()*60000).toISOString().slice(0,16)
  await page.getByLabel('Due date').fill(local)
  await page.getByRole('button',{ name:'Create task' }).click()
  await expect(page.getByRole('heading',{ name })).toBeVisible()
  const url = new URL(page.url()).hash
  await page.getByRole('link',{ name:'All tasks' }).click()
  await expect(page.getByRole('link',{ name:new RegExp(name) })).toHaveAttribute('href',url)
  await page.getByRole('button',{ name:'Due soon' }).click()
  await expect(page.getByRole('link',{ name:new RegExp(name) })).toHaveAttribute('href',url)
  await page.getByRole('link',{ name:'Today',exact:true }).click()
  await expect(page.getByRole('link',{ name:new RegExp(name) })).toHaveAttribute('href',url)
})
