import React from 'react';

export const WelcomeScreen: React.FC = () => {
  return (
    <div className="welcome-screen">
      <div className="welcome-logo">
{`
 ██████╗  ███████╗ ███╗   ███╗ ███████╗
 ██╔══██╗ ██╔════╝ ████╗ ████║ ██╔════╝
 ██║  ██║ ███████╗ ██╔████╔██║ █████╗
 ██║  ██║ ╚════██║ ██║╚██╔╝██║ ██╔══╝
 ██████╔╝ ███████║ ██║ ╚═╝ ██║ ███████╗
 ╚═════╝  ╚══════╝ ╚═╝     ╚═╝ ╚══════╝
`}
      </div>
      <div className="welcome-subtitle">DeepSeek Matrix Engine</div>
      <div className="welcome-version">v0.1.0 — Powered by Silicon Flow</div>

      <div className="welcome-shortcuts">
        <div className="shortcut-group">
          <div className="shortcut-title">[ KEYBOARD SHORTCUTS ]</div>
          <div className="shortcut-row"><span className="shortcut-key">Ctrl+P</span><span className="shortcut-desc">Quick Open File</span></div>
          <div className="shortcut-row"><span className="shortcut-key">Ctrl+S</span><span className="shortcut-desc">Save Current File</span></div>
          <div className="shortcut-row"><span className="shortcut-key">Ctrl+W</span><span className="shortcut-desc">Close Tab</span></div>
          <div className="shortcut-row"><span className="shortcut-key">Ctrl+,</span><span className="shortcut-desc">Settings</span></div>
        </div>

        <div className="shortcut-group">
          <div className="shortcut-title">[ AGENT CAPABILITIES ]</div>
          <div className="shortcut-row"><span className="shortcut-key">read_file</span><span className="shortcut-desc">Read any project file</span></div>
          <div className="shortcut-row"><span className="shortcut-key">write_file</span><span className="shortcut-desc">Create / overwrite files</span></div>
          <div className="shortcut-row"><span className="shortcut-key">replace</span><span className="shortcut-desc">Surgical code edits</span></div>
          <div className="shortcut-row"><span className="shortcut-key">grep</span><span className="shortcut-desc">Search entire codebase</span></div>
          <div className="shortcut-row"><span className="shortcut-key">shell</span><span className="shortcut-desc">Run any terminal command</span></div>
        </div>
      </div>

      <div className="welcome-tip">
        Open a file from <span style={{color: 'var(--accent-color)'}}>[ EXPLORER ]</span> or press <span style={{color: 'var(--accent-color)'}}>Ctrl+P</span> to begin.
      </div>
    </div>
  );
};
