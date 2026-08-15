import { useCallback, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

/**
 * A hover tooltip that follows the pointer.
 *
 * visx ships a tooltip, but its positioning wants a measured container and every chart here lives
 * inside a scrolling page. Fixed positioning off the pointer is both simpler and steadier, and the
 * tooltip is never the only way to read a mark: the bars carry direct labels and the trace has the
 * inspector under it.
 */
export interface TipState {
  x: number
  y: number
  body: ReactNode
}

export function useTip(): {
  tip: TipState | null
  show: (event: { clientX: number; clientY: number }, body: ReactNode) => void
  hide: () => void
} {
  const [tip, setTip] = useState<TipState | null>(null)
  const show = useCallback(
    (event: { clientX: number; clientY: number }, body: ReactNode) =>
      setTip({ x: event.clientX, y: event.clientY, body }),
    [],
  )
  const hide = useCallback(() => setTip(null), [])
  return { tip, show, hide }
}

export function Tip({ tip }: { tip: TipState | null }): ReactElement | null {
  if (tip === null) return null
  // Flip to the other side near the edges so the tooltip never leaves the window.
  const flipX = tip.x > window.innerWidth - 340
  const flipY = tip.y > window.innerHeight - 160
  return (
    <div
      className="tip"
      style={{
        left: flipX ? undefined : tip.x + 14,
        right: flipX ? window.innerWidth - tip.x + 14 : undefined,
        top: flipY ? undefined : tip.y + 16,
        bottom: flipY ? window.innerHeight - tip.y + 16 : undefined,
      }}
    >
      {tip.body}
    </div>
  )
}
