const fail=(status,message)=>Object.assign(Error(message),{status})

const definitions={
  Devin:{ endpoint:'https://api.devin.ai', environment:'DEVIN' },
  Cursor:{ endpoint:'https://api.cursor.com', environment:'CURSOR' },
  Claude:{ endpoint:'https://api.anthropic.com', environment:'ANTHROPIC' },
}

export function providerSecretName(connection){
  const workspace=Buffer.from(connection.workspace_id,'utf8').toString('hex').toUpperCase()
  return 'MYDEV_'+workspace+'_'+definitions[connection.provider].environment+'_'+connection.secret_ref
}

async function call(connection,path,body){
  const definition=definitions[connection.provider]
  const key=process.env[providerSecretName(connection)]
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
  if(connection.provider==='Devin') await call(connection,'/v3/organizations/'+scope+'/sessions?limit=1')
  else if(connection.provider==='Cursor') await call(connection,'/v1/agents?limit=1')
  else await call(connection,'/v1/models/'+scope)
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

export async function runClaude(connection,prompt){
  const result=await call(connection,'/v1/messages',{
    model:connection.external_scope,max_tokens:700,messages:[{role:'user',content:prompt}],
  })
  const answer=result.content?.filter(block=>block.type==='text').map(block=>block.text).join('\n').trim()
  if(!answer) throw fail(502,'Claude did not return a text response.')
  return answer.slice(0,16000)
}
