import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import App from './App'
import { installDebugForwarding } from './lib/debugForward'
import { bootLocale } from './lib/i18n'
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

// One IPC round trip before the first render, so that render is already in the
// chosen language instead of flashing English. bootLocale never throws.
await bootLocale()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
