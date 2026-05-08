import React from 'react';

interface Props {
  activePanel: string;
  onPanelChange: (panel: string) => void;
}

const panels = [
  { id: 'explorer', icon: '📁', label: 'Explorer' },
  { id: 'search', icon: '🔍', label: 'Search' },
  { id: 'git', icon: '⎇', label: 'Source Control' },
];

export const ActivityBar: React.FC<Props> = ({ activePanel, onPanelChange }) => {
  return (
    <div className="activity-bar">
      {panels.map(p => (
        <div
          key={p.id}
          className={`activity-bar-icon ${activePanel === p.id ? 'active' : ''}`}
          onClick={() => onPanelChange(activePanel === p.id ? '' : p.id)}
          title={p.label}
        >
          {p.icon}
        </div>
      ))}
      <div className="activity-bar-spacer" />
      <div
        className="activity-bar-icon bottom"
        onClick={() => onPanelChange(activePanel === 'settings' ? '' : 'settings')}
        title="Settings"
      >
        ⚙
      </div>
    </div>
  );
};
