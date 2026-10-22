import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Defs } from './components/Defs'
import { Chrome, Problem } from './components/Chrome'
import { Shell } from './components/Shell'
import { Context } from './pages/Context'
import { Findings } from './pages/Findings'
import { ImportPage } from './pages/ImportPage'
import { Overview } from './pages/Overview'
import { Project } from './pages/Project'
import { Projects } from './pages/Projects'
import { Questions } from './pages/Questions'
import { Search } from './pages/Search'
import { Session } from './pages/Session'
import { Sessions } from './pages/Sessions'
import { Settings } from './pages/Settings'
import { Spend } from './pages/Spend'
import { Task } from './pages/Task'
import { TokensCache } from './pages/TokensCache'
import { Trails } from './pages/Trails'
import { useRoute } from './router'
import './theme.css'
import type { ReactElement } from 'react'

function Page(): ReactElement {
  const route = useRoute()

  return (
    <Shell route={route}>
      {route.name === 'overview' ? (
        <Overview />
      ) : route.name === 'spend' ? (
        <Spend />
      ) : route.name === 'cache' ? (
        <TokensCache />
      ) : route.name === 'context' ? (
        <Context />
      ) : route.name === 'findings' ? (
        <Findings />
      ) : route.name === 'sessions' ? (
        <Sessions />
      ) : route.name === 'questions' ? (
        <Questions />
      ) : route.name === 'trails' ? (
        <Trails />
      ) : route.name === 'import' ? (
        <ImportPage />
      ) : route.name === 'projects' ? (
        <Projects source={route.source} />
      ) : route.name === 'settings' ? (
        <Settings key={route.tab} tab={route.tab} />
      ) : route.name === 'search' ? (
        <Search
          key={`${route.q}/${route.entity}/${route.slug ?? ''}`}
          q={route.q}
          entity={route.entity}
          slug={route.slug}
        />
      ) : route.name === 'project' ? (
        <Project key={route.slug} slug={route.slug} source={route.source} />
      ) : route.name === 'session' ? (
        <Session
          key={`${route.slug}/${route.session}`}
          slug={route.slug}
          session={route.session}
          source={route.source}
        />
      ) : route.name === 'task' ? (
        <Task
          key={`${route.slug}/${route.session}/${route.task}`}
          slug={route.slug}
          session={route.session}
          task={route.task}
          round={route.round}
          trail={route.trail}
          question={route.question}
          q={route.q}
          source={route.source}
        />
      ) : (
        <>
          <Chrome crumbs={[{ label: 'Not found' }]} />
          <main className="page">
            <Problem message={`There is nothing at ${'path' in route ? route.path : window.location.pathname}.`} />
          </main>
        </>
      )}
    </Shell>
  )
}

function App(): ReactElement {
  return (
    <>
      <Defs />
      <Page />
    </>
  )
}

const root = document.getElementById('root')
/** The mounted page, so whatever mounted it can take it down again: the tests do, before jsdom goes. */
export const page = root === null ? null : createRoot(root)
page?.render(
  <StrictMode>
    <App />
  </StrictMode>,
)
