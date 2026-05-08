import React, { useState, useEffect } from 'react';

interface Props {
  activePath: string;
  language: string;
  cursorPosition: { line: number; column: number };
  gitBranch: string;
}

export const StatusBar: React.FC<Props> = ({ activePath, language, cursorPosition, gitBranch }) => {
  const [model, setModel] = useState('');

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getConfig().then((c: any) => {
        setModel(c?.model?.split('/').pop() || 'DeepSeek-V4-Flash');
      });
    }
  }, []);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-item status-branch">⎇ {gitBranch || 'main'}</span>
        <span className="status-item">{activePath || 'No file'}</span>
      </div>
      <div className="status-bar-right">
        <span className="status-item">Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
        <span className="status-item status-lang">{language}</span>
        <span className="status-item status-encoding">UTF-8</span>
        <span className="status-item status-model">🤖 {model}</span>
        <span className="status-item status-version">DSME v1.0</span>
      </div>
    </div>
  );
};
