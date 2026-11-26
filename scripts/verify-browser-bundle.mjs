import { readdir,readFile } from 'node:fs/promises'
import { join } from 'node:path'

const patterns=[
  { label:'demo password',value:/workspace-demo/ },
  { label:'Supabase secret key',value:/sb_secret_[A-Za-z0-9_-]{16,}/ },
  { label:'Supabase management token',value:/\bsbp_[a-f0-9]{40}\b/i },
  { label:'Postgres password',value:/postgres(?:ql)?:\/\/[^:@\s]+:[^@\s]+@/ },
  { label:'private key',value:/-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]
const files=await readdir('dist',{recursive:true})
if (!files.some(file=>file.endsWith('.js'))) throw Error('Build the browser app before scanning it.')
for (const file of files.filter(file=>/\.(?:js|mjs|html|json|map)$/.test(file))) {
  const contents=await readFile(join('dist',file),'utf8')
  for (const { label,value } of patterns) {
    if (value.test(contents)) throw Error('Browser build contains a '+label+' in '+file)
  }
}
console.log('Browser bundle credential scan passed.')
