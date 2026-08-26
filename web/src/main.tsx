import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Defs } from './components/Defs'
import { Chrome, Problem } from './components/Chrome'
import { Project } from './pages/Project'
import { Projects } from './pages/Projects'
import { Search } from './pages/Search'
import { Session } from './pages/Session'
import { Settings } from './pages/Settings'
import { Task } from './pages/Task'
import { useRoute } from './router'
import './theme.css'
import type { ReactElement } from 'react'

function App(): ReactElement {
  const route = useRoute()

  return (
    <>
      <Defs />
      {route.name === 'projects' ? (
        <Projects />
      ) : route.name === 'settings' ? (
        <Settings />
      ) : route.name === 'search' ? (
        <Search
          key={`${route.q}/${route.entity}/${route.slug ?? ''}`}
          q={route.q}
          entity={route.entity}
          slug={route.slug}
        />
      ) : route.name === 'project' ? (
        <Project key={route.slug} slug={route.slug} />
      ) : route.name === 'session' ? (
        <Session key={`${route.slug}/${route.session}`} slug={route.slug} session={route.session} />
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
        />
      ) : (
        <>
          <Chrome crumbs={[]} />
          <Problem message={`There is nothing at ${route.path}.`} />
        </>
      )}
    </>
  )
}

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
