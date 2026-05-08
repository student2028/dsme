import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export const TerminalPanel: React.FC = () => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#000000',
        foreground: '#00ff00',
        cursor: '#00ff00',
        selectionBackground: 'rgba(0, 255, 0, 0.3)'
      },
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
    });
    termInstance.current = term;
    
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    term.writeln('\x1b[1;32m[SYSTEM TERMINAL HOOKED]\x1b[0m');

    if (window.electronAPI) {
      window.electronAPI.onTerminalOutput((data: string) => {
        term.write(data);
      });

      // Send terminal input to the persistent shell
      term.onData((data) => {
        window.electronAPI.sendTerminalInput(data);
      });
    }

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
    };
  }, []);

  return (
    <div style={{ height: '250px', width: '100%', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '4px 16px', fontSize: '12px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)', fontWeight: 'bold' }}>
        [ ZSH PTY SESSION ]
      </div>
      <div ref={terminalRef} style={{ flex: 1, padding: '8px', background: '#000000', overflow: 'hidden' }} />
    </div>
  );
};
