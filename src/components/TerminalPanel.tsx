import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTheme } from '../ThemeContext';
import '@xterm/xterm/css/xterm.css';

const DARK_THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#7c6ef0',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(124, 110, 240, 0.25)',
  black: '#1e2030',
  red: '#f06060',
  green: '#4ade80',
  yellow: '#e6c84d',
  blue: '#56d4e6',
  magenta: '#c084fc',
  cyan: '#56d4e6',
  white: '#e2e4f0',
};

const LIGHT_THEME = {
  background: '#f5f6f8',
  foreground: '#24292e',
  cursor: '#6c5ce7',
  cursorAccent: '#f5f6f8',
  selectionBackground: 'rgba(108, 92, 231, 0.2)',
  black: '#24292e',
  red: '#d73a49',
  green: '#22863a',
  yellow: '#b08800',
  blue: '#005cc5',
  magenta: '#6f42c1',
  cyan: '#0ea5e9',
  white: '#fafbfc',
};

export const TerminalPanel: React.FC<{ onRequestCollapse?: () => void }> = ({ onRequestCollapse }) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const { theme } = useTheme();

  // Sync terminal theme with app theme
  useEffect(() => {
    if (termInstance.current) {
      termInstance.current.options.theme = theme === 'light' ? LIGHT_THEME : DARK_THEME;
    }
  }, [theme]);

  useEffect(() => {
    if (!terminalRef.current || termInstance.current) return;

    const term = new Terminal({
      theme: theme === 'light' ? LIGHT_THEME : DARK_THEME,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowProposedApi: true,
    });

    termInstance.current = term;
    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);

    // Delay fit to ensure container is sized
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    term.writeln('\x1b[38;2;124;110;240m  DSME Terminal \x1b[38;2;139;143;167m— Ready\x1b[0m');
    term.writeln('');

    // IPC: terminal output → xterm
    let mounted = true;
    let unsubTerminal: (() => void) | undefined;
    if (window.electronAPI) {
      unsubTerminal = window.electronAPI.onTerminalOutput((data: string) => {
        if (mounted && termInstance.current) {
          term.write(data);
        }
      });

      term.onData((data) => {
        window.electronAPI.sendTerminalInput(data);
      });
    }

    // Resize observer for panel drag
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch {}
      });
    });
    observer.observe(terminalRef.current);

    const handleResize = () => {
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch {}
      });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      mounted = false;
      unsubTerminal?.();
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      term.dispose();
      termInstance.current = null;
    };
  }, []);

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-header-left">
          <span className="terminal-header-led" />
          Terminal
        </div>
        {onRequestCollapse && (
          <button
            type="button"
            className="terminal-header-collapse"
            onClick={onRequestCollapse}
            title="收起终端"
            aria-label="Collapse terminal"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      <div ref={terminalRef} className="terminal-content" />
    </div>
  );
};
