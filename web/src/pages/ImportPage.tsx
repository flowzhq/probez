import { useState } from 'react'
import type { ReactElement } from 'react'

import { Chrome } from '../components/Chrome'
import { Import } from '../components/Import'
import { forgetProjectList } from '../components/ScopeBar'
import { href, linkProps } from '../router'

/**
 * Import: open a project someone exported.
 *
 * Its own place in the menu footer rather than a button on the projects list, because importing
 * makes a project and so belongs to the store — and because it is the one thing an empty store can
 * still do.
 */
export function ImportPage(): ReactElement {
  const [done, setDone] = useState(0)
  return (
    <>
      <Chrome crumbs={[{ label: 'Import' }]} />
      <main className="page">
        <div className="head">
          <h1>Import</h1>
        </div>
        <p className="note" style={{ maxWidth: '68ch' }}>
          Read a project someone exported from their probez, as a <span className="mono">.jsonl</span> or{' '}
          <span className="mono">.json</span> file. It is added to this store as its own project, marked{' '}
          <em>imported</em> in Projects — and <em>darkened</em> when its words were replaced on the way out. Importing
          the same project again replaces it. What arrives is somebody else&apos;s work: probez shows it as faithfully
          as your own, prompts and commands included, and cannot check any of it.
        </p>
        <section>
          <Import
            onImported={() => {
              forgetProjectList()
              setDone((was) => was + 1)
            }}
          />
          {done === 0 ? null : (
            <p className="note" style={{ marginTop: 14 }}>
              <a {...linkProps(href.projects())}>Open Projects →</a>
            </p>
          )}
        </section>
      </main>
    </>
  )
}
