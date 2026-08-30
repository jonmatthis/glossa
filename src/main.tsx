import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// NOTE: No StrictMode — its dev-only double-invocation of effects makes the
// greeting turn (6 AI calls) fire twice on every mount. Mount effects here
// are not idempotent-cheap, so StrictMode's safety net costs real money.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
