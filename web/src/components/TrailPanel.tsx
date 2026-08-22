import { duration, percent, tokens } from '../format'
import type { Trail } from '../api'
import type { ReactElement } from 'react'

/**
 * One trail, hop by hop.
 *
 * The bracket on the trace says a trail happened and how far it went. This says what it actually
 * did: which call started it, what each hop had to go on, and where each one landed. It is the same
 * table `probez trail <id>` prints, for the same reason — a claim about provenance that you cannot
 * read the evidence for is a claim you have to take on trust.
 *
 * A row is a call, so clicking one selects that round exactly as clicking its cell in the strip
 * does. The panel and the trace are two views of one selection, never two selections.
 */
export function TrailPanel({
  trail,
  selected,
  onSelect,
  onClose,
}: {
  trail: Trail
  /** The round the inspector is open on, so the trail shows where you are in it. */
  selected: number | null
  onSelect: (round: number) => void
  onClose: () => void
}): ReactElement {
  // How deep each step sits, which is what makes a fan-out read as a fan-out rather than a list.
  const depths = new Map<number, number>()
  for (const step of trail.steps) {
    depths.set(step.at, step.source === null ? 0 : (depths.get(step.source) ?? 0) + 1)
  }

  return (
    <div className="trail-panel">
      <div className="trail-head">
        <strong className="mono">
          trail {trail.ref} → {trail.last}
        </strong>
        <span className="muted">
          {trail.depth} hops from a {trail.root} · {trail.breadth} wide · {trail.paths} paths
          {trail.revisits > 0 ? ` · ${trail.revisits} revisited` : ''}
        </span>
        <span className={trail.outcome === 'edit' ? undefined : 'dim'}>
          {trail.outcome}
          {trail.ended_on === '' ? '' : ` ${trail.ended_on}`}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="muted">
          {duration(trail.ms)} · {tokens(trail.in_tokens)} in · {tokens(trail.out_tokens)} out ·{' '}
          {trail.confidence === 'proven' ? 'hops read out of the results' : 'hops inferred'}
        </span>
        <button className="tag" onClick={onClose}>
          close
        </button>
      </div>

      <table className="trail-steps">
        <thead>
          <tr>
            <th>Round</th>
            <th>Step</th>
            <th title="How wide this call reached: a whole tree, a directory, a file, or a span of lines.">
              Reached
            </th>
            <th title="Why this call follows the one before it, and the path or word that links them.">
              Followed
            </th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          {trail.steps.map((step) => (
            <tr
              key={`${step.at}`}
              className={`row${selected === step.round ? ' here' : ''}`}
              onClick={() => onSelect(step.round)}
            >
              <td className="mono">{step.ref}</td>
              <td className="mono nowrap">
                {/* Indent by hop, capped, so a deep trail stays inside its column. */}
                <span style={{ paddingLeft: Math.min(depths.get(step.at) ?? 0, 5) * 14 }}>
                  {step.name}
                </span>
              </td>
              <td className="dim nowrap">{step.scope}</td>
              <td className="dim nowrap">
                {step.source === null ? (
                  <span className="muted">started here</span>
                ) : (
                  <>
                    {step.edge}{' '}
                    <span className="muted mono" title={step.via}>
                      {step.via}
                    </span>
                  </>
                )}
              </td>
              <td className="muted mono clip" title={step.sites.join(' ')}>
                {step.sites.length === 0 ? '—' : step.sites.join(' ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** What a trail is and what each of its numbers means, for the mark beside a table that lists them. */
export function trailsExplained(share?: { steps: number; finding: number }): ReactElement {
  return (
    <>
      An agent that does not know a repository finds its way around it: it lists the tree, opens what
      the listing named, greps for a word, reads the lines the grep hit. A <strong>trail</strong> is
      one of those searches — the calls that followed one another, rather than the calls that merely
      came one after another.
      {share === undefined || share.finding === 0 ? null : (
        <>
          {' '}
          Here that is {percent(share.steps / share.finding)} of every call that was finding
          something out.
        </>
      )}
      <br />
      <br />
      <span className="tip-key">steps </span>calls in the trail.
      <br />
      <span className="tip-key">depth </span>how far it went — the longest chain of hops.
      <br />
      <span className="tip-key">wide </span>how far it fanned from one call. A listing feeding five
      reads is wide and shallow; a chain of follows is deep and narrow.
      <br />
      <span className="tip-key">paths </span>distinct files and directories it reached.
      <br />
      <span className="tip-key">back </span>places it returned to after leaving them.
      <br />
      <span className="tip-key">started from </span>a listing, a search for a word, a document, or a
      path it was handed.
      <br />
      <span className="tip-key">ended </span>whether it changed something it had been to, only ran
      something, or stopped.
    </>
  )
}

/** The same, as one sentence, for anything that reads the page aloud. */
export const TRAILS_ARIA =
  'A trail is a run of calls that followed one another into the repository. Steps is how many ' +
  'calls; depth how far the search went; wide how far it fanned from one call; paths how many ' +
  'places it reached; back how many it returned to; started from what it began with; ended ' +
  'whether it changed something it had been to.'
