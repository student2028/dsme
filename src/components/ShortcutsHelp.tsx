import React, { useEffect } from 'react';

interface Props {
  onClose: () => void;
}

const shortcuts = [
  {
    group: 'General',
    items: [
      { keys: ['⌘', ','], desc: 'Settings' },
      { keys: ['⇧', '⌘', 'L'], desc: 'Toggle theme' },
      { keys: ['⌘', '?'], desc: 'This help panel' },
    ],
  },
  {
    group: 'Chat & Web Automation',
    items: [
      { keys: ['⌘', 'N'], desc: 'New conversation' },
      { keys: ['⌘', 'L'], desc: 'Focus chat input' },
      { keys: ['⌘', 'F'], desc: 'Find in conversation' },
      { keys: ['Enter'], desc: 'Send message' },
      { keys: ['⇧', 'Enter'], desc: 'New line' },
      { keys: ['⌘', 'V'], desc: 'Paste image' },
      { keys: ['Esc'], desc: 'Close search bar' },
    ],
  }
];

export const ShortcutsHelp: React.FC<Props> = ({ onClose }) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-panel" onClick={e => e.stopPropagation()}>
        <h2>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.001"/><path d="M10 8h.001"/><path d="M14 8h.001"/><path d="M18 8h.001"/><path d="M8 12h.001"/><path d="M12 12h.001"/><path d="M16 12h.001"/><path d="M7 16h10"/>
          </svg>
          Keyboard Shortcuts
        </h2>
        {shortcuts.map(group => (
          <div key={group.group} className="shortcuts-group">
            <div className="shortcuts-group-title">{group.group}</div>
            {group.items.map(item => (
              <div key={item.desc} className="shortcut-row">
                <span className="shortcut-desc">{item.desc}</span>
                <div className="shortcut-keys">
                  {item.keys.map((k, i) => (
                    <span key={i} className="shortcut-key">{k}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};
