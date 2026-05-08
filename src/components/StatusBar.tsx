import React, { useState, useEffect } from 'react';

interface Props {
  activePath: string;
  language: string;
  cursorPosition: { line: number; column: number };
  gitBranch: string;
}

export const StatusBar: React.FC<Props> = ({ activePath, language, cursorPosition, gitBranch }) => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-item status-branch">⎇ {gitBranch || 'main'}</span>
        <span className="status-item">{activePath || 'No file'}</span>
      </div>
      <div className="status-bar-right">
        <span className="status-item">Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
        <span className="status-item">{language.toUpperCase()}</span>
        <span className="status-item">DeepSeek</span>
        <span className="status-item">{time.toLocaleTimeString()}</span>
      </div>
    </div>
  );
};
