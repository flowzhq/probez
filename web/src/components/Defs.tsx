import type { ReactElement } from 'react'
/**
 * The hatch every unclassified mark is filled with.
 *
 * One definition, mounted once at the root, referenced by every chart. It is the accessibility
 * channel doing double duty: it separates the neutral from the eight series colours without adding
 * a ninth hue, and it reads at a glance as "not a category" rather than as another one.
 */
export function Defs(): ReactElement {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
      <defs>
        <pattern
          id="probez-hatch"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="5" height="5" fill="var(--series-none)" />
          <line x1="0" y1="0" x2="0" y2="5" stroke="var(--hatch-ink)" strokeWidth="1.4" />
        </pattern>
      </defs>
    </svg>
  )
}
