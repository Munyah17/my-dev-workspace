import { httpsObservation } from '../worker/network.js'
import { openProviderKey } from './provider-secrets.js'

const fail=(status,message)=>Object.assign(Error(message),{status})

const definitions={
  Devin:{ endpoint:'https://api.devin.ai', environment:'DEVIN' },
  Cursor:{ endpoint:'https://api.cursor.com', environment:'CURSOR' },
  Claude:{ endpoint:'https://api.anthropic.com', environment:'ANTHROPIC' },
  Codex:{ endpoint:'https://api.openai.com', environment:'CODEX' },
  ChatGPT:{ endpoint:'https://api.openai.com', environment:'OPENAI' },
  Vercel:{ endpoint:'https://api.vercel.com', environment:'VERCEL' },
  Supabase:{ endpoint:'https://api.supabase.com', environment:'SUPABASE' },
  Cloudflare:{ endpoint:'https://api.cloudflare.com', environment:'CLOUDFLARE' },
  Firebase:{ endpoint:'https://firebase.googleapis.com', environment:'FIREBASE' },
  Stripe:{ endpoint:'https://api.stripe.com', environment:'STRIPE' },
  Sentry:{ endpoint:'https://sentry.io', environment:'SENTRY' },
  WHM:{ environment:'WHM',port:'2087' },
  cPanel:{ environment:'CPANEL',port:'2083' },
  Netlify:{ endpoint:'https://api.netlify.com', environment:'NETLIFY' },
}

export const promptProviders=['Claude','Codex','ChatGPT']

export function validateProviderScope(provider,scope){
  if (!Object.hasOwn(definitions,provider)) return false
  if (provider==='Stripe') return /^acct_[a-zA-Z0-9]+$/.test(scope)
  if (provider==='Sentry') return /^[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(scope)
  if (definitions[provider].port) return /^(?:[a-z][a-z0-9-]{0,62}\.)+[a-z]{2,63}\/[a-z0-9_-]{1,64}$/i.test(scope)
  if (provider==='Cursor') return scope==='Cloud Agents'
  if (provider==='Vercel') return /^[A-Za-z0-9_][A-Za-z0-9_-]{1,99}(?:\/team_[A-Za-z0-9]+)?$/.test(scope)
  return /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{2,119}$/.test(scope)
}

export function providerSecretName(connection){
  const workspace=Buffer.from(connection.workspace_id,'utf8').toString('hex').toUpperCase()
  return 'MYDEV_'+workspace+'_'+definitions[connection.provider].environment+'_'+connection.secret_ref
}

async function call(connection,path,body,deadline){
  const definition=definitions[connection.provider]
  const key=connection.ciphertext ? openProviderKey(connection,connection.ciphertext) : process.env[providerSecretName(connection)]
  if(!key) throw fail(409,'The connection’s server credential is not configured.')
  if(connection.provider==='Stripe' && !/^rk_live_/.test(key)) throw fail(400,'Use a live Stripe restricted key with read access.')
  if(definition.port){
    const [host,user]=connection.external_scope.split('/')
    try{
      const result=await httpsObservation('https://'+host+':'+definition.port+path,{
        signal:AbortSignal.timeout(10000),headers:{Authorization:connection.provider.toLowerCase()+' '+user+':'+key},
        followRedirects:false,includeBody:true,hostingPort:definition.port,
      })
      if(result.status!==200) throw Error()
      return JSON.parse(result.body)
    }catch{throw fail(502,'Check the hosting hostname, username, TLS certificate, and token permissions.')}
  }
  const headers={ 'Content-Type':'application/json' }
  if(connection.provider==='Claude'){
    headers['x-api-key']=key
    headers['anthropic-version']='2023-06-01'
  }else if(connection.provider==='Cursor') headers.Authorization='Basic '+Buffer.from(key+':').toString('base64')
  else headers.Authorization='Bearer '+key
  let response
  try {
    response=await fetch(definition.endpoint+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,
      redirect:'error',signal:deadline ? AbortSignal.any([deadline,AbortSignal.timeout(10000)]) : AbortSignal.timeout(body?25000:10000)})
  }catch{throw fail(502,'The provider could not be reached.')}
  if(!response.ok) throw fail(502,'The provider returned HTTP '+response.status+'. Check credential permissions and scope.')
  try{return await response.json()}catch{throw fail(502,'The provider returned an unreadable response.')}
}

export async function checkDeveloperConnection(connection){
  const scope=encodeURIComponent(connection.external_scope)
  const provider=connection.provider
  if(provider==='WHM' || provider==='cPanel'){
    const accounts=await hostingResources(connection)
    return {name:connection.external_scope,status:accounts.length+' visible '+(provider==='WHM'?'accounts':'domains')}
  }
  if(provider==='Sentry'){
    await sentryIssues(connection)
    return {name:connection.external_scope}
  }
  if(provider==='Stripe'){
    const account=await call(connection,'/v1/account')
    if(account.id!==connection.external_scope) throw fail(409,'This key belongs to a different Stripe account.')
    await call(connection,'/v1/charges?limit=1')
    return {name:account.id}
  }
  if(provider==='Devin') {
    await call(connection,'/v3/organizations/'+scope+'/sessions?limit=1')
    return {name:connection.external_scope}
  }
  if(provider==='Cursor') {
    await call(connection,'/v1/agents?limit=1')
    return {name:'Cloud Agents'}
  }
  if(promptProviders.includes(provider)) {
    const model=await call(connection,'/v1/models/'+scope)
    if(!model.id) throw fail(502,'The provider did not return a model ID.')
    return {name:String(model.display_name??model.id).slice(0,180)}
  }
  const [project,team]=connection.external_scope.split('/')
  const path={
    Vercel:'/v9/projects/'+encodeURIComponent(project)+(team?'?teamId='+encodeURIComponent(team):''),
    Supabase:'/v1/projects/'+scope,
    Cloudflare:'/client/v4/zones/'+scope,
    Firebase:'/v1beta1/projects/'+scope,
    Netlify:'/api/v1/sites/'+scope,
  }[provider]
  if(!path) throw fail(400,'Unsupported provider.')
  const result=await call(connection,path)
  const resource=provider==='Cloudflare' && result.success===true ? result.result : result
  if(!resource || !(resource.id || resource.projectId || resource.ref)) throw fail(502,'The provider did not return a resource identity.')
  return {
    name:String(resource.displayName??resource.name??resource.projectId??resource.ref??resource.id).slice(0,180),
    status:typeof resource.status==='string'?resource.status.slice(0,120):null,
  }
}

export async function developerStatus(connection,link){
  const remote=new URL(link.url)
  if(!remote.pathname.split('/').filter(Boolean).length) throw fail(400,'Use the link to the specific agent or session.')
  const identifier=remote.pathname.split('/').filter(Boolean).at(-1)
  if(!/^[a-zA-Z0-9_-]{5,180}$/.test(identifier)) throw fail(400,'The link has no supported remote identifier.')
  if(connection.provider==='Cursor'){
    if(!remote.pathname.startsWith('/agents/') || !identifier.startsWith('bc-')) throw fail(400,'Use a Cursor cloud agent link.')
    const result=await call(connection,'/v1/agents/'+encodeURIComponent(identifier))
    return {status:String(result.agent?.status??result.status??'Unknown').slice(0,120)}
  }
  if(!remote.pathname.startsWith('/sessions/') || !identifier.startsWith('devin-')) throw fail(400,'Use a Devin session link.')
  const result=await call(connection,'/v3/organizations/'+encodeURIComponent(connection.external_scope)+'/sessions/'+encodeURIComponent(identifier))
  return {status:String(result.status??result.session?.status??'Unknown').slice(0,120)}
}

export async function runDeveloperModel(connection,prompt){
  if(connection.provider!=='Claude'){
    const result=await call(connection,'/v1/responses',{model:connection.external_scope,input:prompt,max_output_tokens:1000,store:false})
    const output=result.output?.flatMap(item=>item.content??[]).filter(item=>item.type==='output_text').map(item=>item.text).join('\n').trim()
    if(!output) throw fail(502,connection.provider+' did not return a text response.')
    return output.slice(0,16000)
  }
  const result=await call(connection,'/v1/messages',{
    model:connection.external_scope,max_tokens:700,messages:[{role:'user',content:prompt}],
  })
  const answer=result.content?.filter(block=>block.type==='text').map(block=>block.text).join('\n').trim()
  if(!answer) throw fail(502,'Claude did not return a text response.')
  return answer.slice(0,16000)
}

export async function hostingResources(connection){
  if(connection.provider==='WHM'){
    const result=await call(connection,'/json-api/listaccts?api.version=1')
    if(Number(result.metadata?.result)!==1 || !Array.isArray(result.data?.acct ?? [])) throw fail(502,'WHM did not authorize account listing.')
    return (result.data?.acct ?? []).map(item=>({domain:item.domain,user:item.user,suspended:String(item.suspended)==='1'}))
  }
  const result=await call(connection,'/execute/DomainInfo/list_domains')
  if(result.status!==1 || !result.data) throw fail(502,'cPanel did not authorize domain listing.')
  const {main_domain,addon_domains=[],parked_domains=[],sub_domains=[]}=result.data
  return [...new Set([main_domain,...addon_domains,...parked_domains,...sub_domains].filter(Boolean))].map(domain=>({domain}))
}

export async function sentryIssues(connection){
  const [org,project]=connection.external_scope.split('/')
  const result=await call(connection,'/api/0/projects/'+encodeURIComponent(org)+'/'+encodeURIComponent(project)+'/issues/?query=is%3Aunresolved&limit=20')
  if(!Array.isArray(result)) throw fail(502,'Sentry did not return a list of issues.')
  return result.slice(0,20).filter(issue=>/^\d{1,32}$/.test(issue.id)).map(issue=>({
    id:String(issue.id),key:String(issue.shortId??issue.id).slice(0,60),
    title:String(issue.title??'Production issue').slice(0,160),lastSeen:issue.lastSeen,
  }))
}

export async function stripeCollections(connection,start,end,app){
  const totals=new Map()
  const deadline=AbortSignal.timeout(20000)
  const params=new URLSearchParams({'created[gte]':start,'created[lt]':end,limit:100})
  for(let page=0;page<25;page++){
    const result=await call(connection,'/v1/charges?'+params,undefined,deadline)
    if(!Array.isArray(result.data) || (result.has_more && !result.data.length)) throw fail(502,'Stripe did not return a complete page of charges.')
    for(const charge of result.data){
      if(charge.status!=='succeeded' || !charge.paid || !charge.captured || (app && charge.metadata?.app!==app)) continue
      const {amount_captured:gross,amount_refunded:refund,currency}=charge
      if(!/^[a-z]{3}$/.test(currency) || !Number.isSafeInteger(gross) || !Number.isSafeInteger(refund) || refund<0 || gross<refund)
        throw fail(502,'Stripe returned an invalid amount.')
      const bucket=totals.get(currency)??{gross:0,refund:0}
      bucket.gross+=gross
      bucket.refund+=refund
      if(!Number.isSafeInteger(bucket.gross) || !Number.isSafeInteger(bucket.refund)) throw fail(502,'Stripe totals exceed supported precision.')
      totals.set(currency,bucket)
    }
    if(!result.has_more) return Object.fromEntries(totals)
    params.set('starting_after',result.data.at(-1).id)
  }
  throw fail(422,'Narrow the date range to report on fewer Stripe charges.')
}
