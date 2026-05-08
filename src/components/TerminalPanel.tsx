import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export const TerminalPanel: React.FC = () => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstance = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current || termInstance.current) return;

    const term = new Terminal({
      theme: {
        background: '#000000',
        foreground: '#00ff00',
        cursor: '#00ff00',
        cursorAccent: '#000000',
        selectionBackground: 'rgba(0, 255, 0, 0.3)',
        black: '#000000',
        red: '#ff4444',
        green: '#00ff00',
        yellow: '#eab308',
        blue: '#00ccff',
        magenta: '#cc66ff',
        cyan: '#00ccff',
        white: '#ffffff',
      },
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
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

    term.writeln('\x1b[1;32m╔══════════════════════════════════════╗\x1b[0m');
    term.writeln('\x1b[1;32m║   DSME Terminal — zsh PTY Session    ║\x1b[0m');
    term.writeln('\x1b[1;32m╚══════════════════════════════════════╝\x1b[0m');
    term.writeln('');

    if (window.electronAPI) {
      window.electronAPI.onTerminalOutput((data: string) => {
        term.write(data);
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
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      term.dispose();
      termInstance.current = null;
    };
  }, []);

  return (
    <div className="terminal-panel">
      <div className="terminal-header">[ ZSH PTY SESSION ]</div>
      <div ref={terminalRef} className="terminal-content" />
    </div>
  );
};
