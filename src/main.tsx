import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from './ThemeContext.tsx'

const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
if (platform.includes('mac')) {
  document.documentElement.classList.add('platform-darwin')
}

// Global native context menu blocker to prevent Electron C++ crashes on right-click
// This stops Chromium from trying to build the context-menu payload in the main process,
// which triggers the rust_bmp/NSApplication sendEvent SIGSEGV on macOS arm64.
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
