import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import App from './App'
import { installDebugForwarding } from './lib/debugForward'
import './styles/global.css'
// After global.css on purpose: the dialog footer alignment and the compact
// empty state override rules there and have to win on source order.
import './styles/dialogs.css'
import './styles/monitorNav.css'
import '@xterm/xterm/css/xterm.css'

// Before the tree mounts, so an error thrown during the first render is
// already being forwarded when it happens. Main drops these unless debug mode
// is on.
installDebugForwarding()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
