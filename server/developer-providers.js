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
  Netlify:{ endpoint:'https://api.netlify.com', environment:'NETLIFY' },
}

export const promptProviders=['Claude','Codex','ChatGPT']

export function validateProviderScope(provider,scope){
  if (!Object.hasOwn(definitions,provider)) return false
  if (provider==='Cursor') return scope==='Cloud Agents'
  if (provider==='Vercel') return /^[A-Za-z0-9_][A-Za-z0-9_-]{1,99}(?:\/team_[A-Za-z0-9]+)?$/.test(scope)
  return /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{2,119}$/.test(scope)
}

export function providerSecretName(connection){
  const workspace=Buffer.from(connection.workspace_id,'utf8').toString('hex').toUpperCase()
  return 'MYDEV_'+workspace+'_'+definitions[connection.provider].environment+'_'+connection.secret_ref
}

async function call(connection,path,body){
  const definition=definitions[connection.provider]
  const key=connection.ciphertext ? openProviderKey(connection,connection.ciphertext) : process.env[providerSecretName(connection)]
  if(!key) throw fail(409,'The connection’s server credential is not configured.')
  const headers={ 'Content-Type':'application/json' }
  if(connection.provider==='Claude'){
    headers['x-api-key']=key
    headers['anthropic-version']='2023-06-01'
  }else if(connection.provider==='Cursor') headers.Authorization='Basic '+Buffer.from(key+':').toString('base64')
  else headers.Authorization='Bearer '+key
  let response
  try {
    response=await fetch(definition.endpoint+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,
      redirect:'error',signal:AbortSignal.timeout(body?25000:10000)})
  }catch{throw fail(502,'The provider could not be reached.')}
  if(!response.ok) throw fail(502,'The provider returned HTTP '+response.status+'. Check credential permissions and scope.')
  try{return await response.json()}catch{throw fail(502,'The provider returned an unreadable response.')}
}

export async function checkDeveloperConnection(connection){
  const scope=encodeURIComponent(connection.external_scope)
  const provider=connection.provider
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
