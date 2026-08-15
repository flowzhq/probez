import { useEffect, useState } from 'react'

/**
 * One fetch, with the two states a page has to draw besides the answer.
 *
 * A re-read keeps what is already on screen rather than blanking it. Syncing a project re-reads the
 * page behind it, and clearing first would unmount the button you just pressed along with whatever
 * it was telling you it had done — the refetch would destroy its own result.
 *
 * That is safe only because stale data can never belong to something else: every page is keyed on
 * what it is showing, so navigating from one project to another remounts rather than reusing. If
 * you add a page here, key it the same way.
 */
export function useData<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    load()
      .then((value) => {
        if (!live) return
        setData(value)
        setLoading(false)
      })
      .catch((problem: Error) => {
        if (!live) return
        setError(problem.message)
        setLoading(false)
      })
    return () => {
      live = false
    }
    // The caller's closure changes on every render; the dependency list it passes is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { data, error, loading }
}
