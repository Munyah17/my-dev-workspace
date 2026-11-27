import { expect,test } from '@playwright/test'

test('theme switch keeps the sun left, the moon right, and remembers the selection',async({page})=>{
  await page.goto('/')
  const toggle=page.getByRole('switch',{name:'Dark mode'})
  await expect(toggle).toHaveText('☀☾')
  await expect(toggle).toHaveAttribute('aria-checked','false')
  await toggle.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark')
  await expect(toggle).toHaveAttribute('aria-checked','true')
  await page.getByRole('button',{name:'Agency'}).click()
  await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeVisible()
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-checked','true')
  await toggle.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme','light')
})

test('a recovered dashboard refresh clears the temporary API alert',async({page})=>{
  let requests=0
  await page.route('**/api/dashboard/core',route=>{
    if(requests++===0) return route.fulfill({status:503,json:{error:'Temporary dashboard error.'}})
    return route.continue()
  })
  await page.goto('/')
  await page.getByRole('button',{name:'Agency'}).click()
  const alert=page.getByRole('alert').filter({ hasText:'Temporary dashboard error.' })
  await expect(alert).toBeVisible()
  await expect(alert).toHaveCount(0,{ timeout:10000 })
})
