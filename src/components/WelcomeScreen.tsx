import React from 'react';

// Dolphin logo mark for DSME
const LogoMark = () => (
  <div style={{
    width: 56, height: 56, borderRadius: 16,
    background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 32, boxShadow: '0 4px 20px rgba(14,165,233,0.3)'
  }}>🐬</div>
);

export const WelcomeScreen: React.FC = () => {
  return (
    <div className="welcome-screen">
      <div className="welcome-hero">
        <LogoMark />
        <div className="welcome-brand">
          <h1 className="welcome-title">DSME</h1>
          <p className="welcome-tagline">DeepSeek Matrix Engine</p>
        </div>
      </div>

      <div className="welcome-grid">
        <div className="welcome-card">
          <div className="welcome-card-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></svg>
            <span>Shortcuts</span>
          </div>
          <div className="welcome-card-body">
            <div className="shortcut-row"><kbd>⌘P</kbd><span>Quick Open</span></div>
            <div className="shortcut-row"><kbd>⌘S</kbd><span>Save</span></div>
            <div className="shortcut-row"><kbd>⌘B</kbd><span>Toggle Sidebar</span></div>
            <div className="shortcut-row"><kbd>⌘L</kbd><span>Focus Chat</span></div>
            <div className="shortcut-row"><kbd>⌘,</kbd><span>Settings</span></div>
            <div className="shortcut-row"><kbd>⇧⌘L</kbd><span>Toggle Theme</span></div>
          </div>
        </div>

        <div className="welcome-card">
          <div className="welcome-card-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            <span>AI Assistant</span>
          </div>
          <div className="welcome-card-body">
            <div className="shortcut-row"><kbd>🔍</kbd><span>Web search & real-time info</span></div>
            <div className="shortcut-row"><kbd>📖</kbd><span>Read & explore files</span></div>
            <div className="shortcut-row"><kbd>✏️</kbd><span>Create & edit code</span></div>
            <div className="shortcut-row"><kbd>⚡</kbd><span>Run shell commands</span></div>
            <div className="shortcut-row"><kbd>🌐</kbd><span>Fetch & read web pages</span></div>
          </div>
        </div>
      </div>

      <p className="welcome-footer">
        Press <kbd>⌘P</kbd> to open a file or use the sidebar to browse your project
      </p>
    </div>
  );
};
