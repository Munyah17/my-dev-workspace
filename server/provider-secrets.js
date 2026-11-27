import { createCipheriv,createDecipheriv,hkdfSync,randomBytes } from 'node:crypto'

function options(){
  const material=[]
  if(process.env.WORKSPACE_CREDENTIALS_KEY) material.push(process.env.WORKSPACE_CREDENTIALS_KEY)
  if(process.env.SUPABASE_DATABASE_URL) material.push(new URL(process.env.SUPABASE_DATABASE_URL).password)
  return material.filter(value=>value.length>=24).map(value=>
    Buffer.from(hkdfSync('sha256',value,'mydev-provider-keys','developer-connection-v1',32)))
}

function unavailable(){
  return Object.assign(Error('Provider credential storage is unavailable. Configure a server credential reference or the workspace encryption key.'),{status:503})
}

function context(connection){
  return Buffer.from(JSON.stringify([connection.workspace_id,connection.provider,connection.external_scope]))
}

export function sealProviderKey(connection,key){
  if(typeof key!=='string' || !/^[\x21-\x7e]{8,2048}$/.test(key))
    throw Object.assign(Error('Enter a valid API key or access token.'),{status:400})
  const [keyMaterial]=options()
  if(!keyMaterial) throw unavailable()
  const iv=randomBytes(12)
  const cipher=createCipheriv('aes-256-gcm',keyMaterial,iv)
  cipher.setAAD(context(connection))
  const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()])
  return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64')
}

export function openProviderKey(connection,sealed){
  const bytes=Buffer.from(sealed,'base64')
  for(const key of options()){
    try{
      const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12))
      decipher.setAAD(context(connection))
      decipher.setAuthTag(bytes.subarray(12,28))
      return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')
    }catch{ /* Try the previous runtime derivation if it is still configured. */ }
  }
  throw unavailable()
}
