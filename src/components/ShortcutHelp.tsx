import React from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const shortcuts = [
  { category: 'FILE', items: [
    { keys: 'Ctrl+P', desc: 'Quick open file' },
    { keys: 'Ctrl+S', desc: 'Save current file' },
    { keys: 'Ctrl+W', desc: 'Close current tab' },
  ]},
  { category: 'SEARCH', items: [
    { keys: 'Ctrl+Shift+F', desc: 'Search in workspace' },
    { keys: 'Ctrl+F', desc: 'Find in file (Monaco)' },
    { keys: 'Ctrl+H', desc: 'Replace in file (Monaco)' },
  ]},
  { category: 'NAVIGATION', items: [
    { keys: 'Ctrl+G', desc: 'Go to line (Monaco)' },
    { keys: 'Ctrl+Shift+O', desc: 'Go to symbol (Monaco)' },
  ]},
  { category: 'IDE', items: [
    { keys: 'Ctrl+,', desc: 'Open settings' },
    { keys: 'Ctrl+?', desc: 'Show this help' },
  ]},
];

export const ShortcutHelp: React.FC<Props> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="shortcut-help-panel" onClick={e => e.stopPropagation()}>
        <div className="shortcut-help-title">[ KEYBOARD SHORTCUTS ]</div>
        {shortcuts.map(cat => (
          <div key={cat.category} className="shortcut-help-cat">
            <div className="shortcut-help-cat-name">{cat.category}</div>
            {cat.items.map(item => (
              <div key={item.keys} className="shortcut-help-row">
                <span className="shortcut-help-key">{item.keys}</span>
                <span className="shortcut-help-desc">{item.desc}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="shortcut-help-footer">Press Escape to close</div>
      </div>
    </div>
  );
};
