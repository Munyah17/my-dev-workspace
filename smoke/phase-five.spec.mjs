import { expect,test } from '@playwright/test'

test('an accepted quotation opens one order in the agency interface',async({page})=>{
  await page.goto('/')
  await page.getByRole('button',{name:'Agency'}).click()
  await page.getByRole('link',{name:'Billing',exact:true}).click()
  const suffix=Date.now()
  const future=new Date(Date.now()+10*86400000).toISOString().slice(0,10)
  const draft=await page.request.post('/api/billing/documents',{data:{
    workspace:'demo',organization:'gents',kind:'quote',currency:'USD',due:future,
    items:[{description:'Tracker install '+suffix,quantity:1,unit:5000}],
  }})
  expect(draft.ok()).toBeTruthy()
  const {id}=await draft.json()
  expect((await page.request.post('/api/billing/documents/'+id+'/issue',{data:{}})).ok()).toBeTruthy()
  expect((await page.request.post('/api/billing/documents/'+id+'/decision',{data:{decision:'accepted'}})).ok()).toBeTruthy()
  await page.goto('/#billing/'+id)
  await page.getByRole('button',{name:'Convert to order'}).click()
  await expect(page.getByRole('heading',{name:/Order \d+ · The Gents/})).toBeVisible()
  await expect(page.getByText('Tracker install '+suffix,{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Confirmed',exact:true}).click()
  await expect(page.getByText('Confirmed',{exact:true})).toBeVisible()
})
