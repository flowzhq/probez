import type { ReactElement } from 'react'
/**
 * The two patterns every chart references, mounted once at the root.
 *
 * `probez-hatch` is what an unclassified mark is *filled* with: an opaque neutral with diagonals
 * over it. It is the accessibility channel doing double duty — it separates the neutral from the
 * eight series colours without adding a ninth hue, and reads at a glance as "not a category"
 * rather than as another one.
 *
 * `probez-lines` is the same diagonals with nothing behind them, to be laid *over* a mark that
 * already has a colour. That is the difference that matters: a sub drawn with it keeps its
 * category's hue and gains a texture, so it is picked out of the category without being mistaken
 * for the hole. Shade alone was doing this job and doing it faintly, which is what a strip drawn at
 * a pixel and a half will do to a difference in lightness.
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
        <pattern
          id="probez-lines"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          {/* Tighter than the fill above, because this one has to read on a mark a few pixels
              wide as well as on a bar a hundred. No background: what is underneath shows through,
              which is the whole point of it. */}
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--hatch-ink)" strokeWidth="1.1" />
        </pattern>
      </defs>
    </svg>
  )
}
