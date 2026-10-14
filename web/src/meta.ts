import { useEffect, useState } from 'react'

import { api } from './api'
import type { IdentityPayload, MetaPayload } from './api'

/**
 * How this run of `probez view` was started, and who the store's rounds belong to.
 *
 * Both are read once a page load: `--debug` cannot change while the server runs, and the names
 * change only when a merge or Settings changes them, both of which call `forgetIdentity`.
 */

let meta: Promise<MetaPayload> | null = null
let identity: Promise<IdentityPayload> | null = null

function readMeta(): Promise<MetaPayload> {
  meta ??= api.meta().catch(() => {
    meta = null
    return { debug: false }
  })
  return meta
}

function readIdentity(): Promise<IdentityPayload> {
  identity ??= api.identity().catch((error: unknown) => {
    identity = null
    throw error
  })
  return identity
}

const listeners = new Set<() => void>()

/** Read the names again, after a merge brought somebody new or Settings renamed this machine. */
export function forgetIdentity(): void {
  identity = null
  for (const listener of listeners) listener()
}

/**
 * Whether trails and questions are on. False until the answer arrives, so a run without `--debug`
 * never flashes a menu item it is about to take away.
 */
export function useDebug(): boolean {
  const [debug, setDebug] = useState(false)
  useEffect(() => {
    let live = true
    void readMeta().then((value) => {
      if (live) setDebug(value.debug)
    })
    return () => {
      live = false
    }
  }, [])
  return debug
}

/** Who this machine is, and every name in the store. Null until read. */
export function useIdentity(): IdentityPayload | null {
  const [value, setValue] = useState<IdentityPayload | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = (): void => setVersion((was) => was + 1)
    listeners.add(bump)
    return () => {
      listeners.delete(bump)
    }
  }, [])
  useEffect(() => {
    let live = true
    readIdentity()
      .then((read) => {
        if (live) setValue(read)
      })
      .catch(() => {
        if (live) setValue(null)
      })
    return () => {
      live = false
    }
  }, [version])
  return value
}
