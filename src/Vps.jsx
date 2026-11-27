import { useRef,useState } from 'react'
import { useRecord } from './useRecord.js'

const hourlyUsd=new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',currencyDisplay:'code',maximumFractionDigits:6})
const usd=value=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(Number(value)/100)

export function Vps({api,revision,busy,action,platform}){
  const [workspace,setWorkspace]=useState('')
  const [duration,setDuration]=useState(60)
  const request=useRef(null)
  const {value,error}=useRecord(api,'vps'+(workspace?'?workspace='+encodeURIComponent(workspace):''),revision)
  const reserve=event=>{
    event.preventDefault()
    const form=event.currentTarget
    const fields=Object.fromEntries(new FormData(form))
    const payload={workspace:value.workspace,label:fields.label,sshKey:fields.sshKey,minutes:Number(fields.minutes),hourlyPriceMicros:value.hourlyPriceMicros}
    const signature=JSON.stringify(payload)
    if(request.current?.signature!==signature) request.current={signature,id:crypto.randomUUID()}
    action(async()=>{
      await api('vps/reserve',{...payload,id:request.current.id})
      request.current=null
      form.reset()
    })
  }
  return <>
    <section className="panel">
      <h2>Prepaid VPS wallet</h2>
      <p>The Linux guest includes NGINX for serving static files from <code>/srv/www</code>.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {value && <>
        {value.workspaces.length>1 && <label>Workspace<select value={value.workspace} onChange={event=>setWorkspace(event.target.value)}>
          {value.workspaces.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
        <p>Available balance <strong>{usd(value.balance)}</strong></p>
        <p>Usage is billed in USD by the minute, rounded up to a whole cent. Your wallet reserves the maximum charge before the server starts.</p>
        <p>Wallet credits are posted by a platform admin after settlement. Online top-up is unavailable.</p>
        {!value.enabled && <p>VPS pricing and rentals are unavailable for this workspace.</p>}
        {value.enabled && <form className="fields" onSubmit={reserve}>
          <label>Server name<input name="label" required maxLength="100" /></label>
          <label>Ed25519 SSH public key<textarea name="sshKey" required maxLength="120" /></label>
          <label>Maximum lifetime in minutes<input name="minutes" type="number" min="15" max="1440" required value={duration} onChange={event=>setDuration(event.target.value)} /></label>
          <p>Usage price <strong>{hourlyUsd.format(value.hourlyPriceMicros/1000000)} per hour</strong></p>
          <p>Maximum wallet hold <strong>{duration>=15 && duration<=1440 && Number.isInteger(Number(duration)) ? usd(Math.ceil(duration*value.hourlyPriceMicros/600000)) : '—'}</strong></p>
          <p>One temporary Linux server per workspace. Ending a rental erases its files.</p>
          <button className="primary" disabled={busy}>Create VPS</button>
        </form>}
      </>}
    </section>
    {value && <section className="panel">
      <h2>My servers <button disabled={busy} onClick={()=>action(async()=>{})}>Refresh</button></h2>
      {value.rentals.length===0 && <p>No servers yet.</p>}
      {value.rentals.map(item=><div className="row" key={item.id}>
        <div><strong>{item.label}</strong><small>{item.state.replaceAll('_',' ')} · {item.charged===null?usd(item.reserved)+' reserved':usd(item.charged)+' charged'}</small>
          {item.state==='running' && item.host && <small>SSH <code>ssh root@{item.host}</code> · Ends {new Date(item.ends_at).toLocaleString()}</small>}
        </div>
        {['queued','running'].includes(item.state) && <button disabled={busy} onClick={()=>{
          if(item.state==='queued'||window.confirm('End this VPS now and erase its files?')) action(()=>api('vps/end',{id:item.id}))
        }}>End rental</button>}
      </div>)}
    </section>}
    {value?.ledger.length>0 && <section className="panel"><h2>Wallet activity</h2>
      {value.ledger.map(item=><div className="row" key={item.id}><span>{item.kind} · {new Date(item.created_at).toLocaleDateString()}</span><strong>{usd(item.amount)}</strong></div>)}
    </section>}
    {platform && <section className="panel"><h2>Record settled wallet top-up</h2>
      <form className="fields" onSubmit={event=>{
        event.preventDefault()
        const element=event.currentTarget
        const fields=Object.fromEntries(new FormData(element))
        action(async()=>{
          await api('vps/credit',{workspace:fields.workspace,reference:fields.reference,amount:Math.round(Number(fields.amount)*100)})
          element.reset()
        })
      }}>
        <label>Workspace ID<input name="workspace" defaultValue={value?.workspace} required maxLength="120" /></label>
        <label>Verified payment reference<input name="reference" required maxLength="120" /></label>
        <label>Settled amount in USD<input name="amount" type="number" min=".01" step=".01" required /></label>
        <button disabled={busy}>Credit wallet</button>
      </form>
    </section>}
  </>
}
