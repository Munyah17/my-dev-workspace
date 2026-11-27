import { useEffect,useState } from 'react'

export function useRecord(api, path, revision) {
  const [record, setRecord] = useState({ path: null })
  useEffect(() => {
    if (!path) return
    let active = true
    let timer
    const refresh = async () => {
      try {
        const value = await api(path)
        if (active) setRecord({ path, value })
      } catch (error) {
        if (active) setRecord(previous => ({ path, value:previous.path===path ? previous.value : undefined,error:error.message }))
      } finally {
        if (active) timer = setTimeout(refresh,4000)
      }
    }
    refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [api, path, revision])
  return record.path === path ? record : {}
}
