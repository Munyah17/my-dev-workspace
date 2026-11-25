import { useEffect,useState } from 'react'

export function useRecord(api, path, revision) {
  const [record, setRecord] = useState({ path: null })
  useEffect(() => {
    if (!path) return
    let active = true
    const refresh = () => api(path).then(value => { if (active) setRecord({ path, value }) })
      .catch(error => { if (active) setRecord({ path, error: error.message }) })
    refresh()
    const timer = setInterval(refresh, 4000)
    return () => { active = false; clearInterval(timer) }
  }, [api, path, revision])
  return record.path === path ? record : {}
}
