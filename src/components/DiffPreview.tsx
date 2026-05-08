import React, { useState } from 'react';

interface DiffChange {
  id: string;
  filepath: string;
  filename: string;
  oldContent: string;
  newContent: string;
  status: 'pending' | 'accepted' | 'rejected';
}

interface Props {
  changes: DiffChange[];
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  onClose: () => void;
}

function computeDiff(oldText: string, newText: string): { type: 'same' | 'add' | 'remove'; line: string }[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: { type: 'same' | 'add' | 'remove'; line: string }[] = [];

  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oi = 0, ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      result.push({ type: 'same', line: oldLines[oi] });
      oi++; ni++;
    } else if (oi < oldLines.length && (ni >= newLines.length || !newLines.slice(ni).includes(oldLines[oi]))) {
      result.push({ type: 'remove', line: oldLines[oi] });
      oi++;
    } else if (ni < newLines.length) {
      result.push({ type: 'add', line: newLines[ni] });
      ni++;
    } else {
      break;
    }
  }

  return result;
}

export const DiffPreview: React.FC<Props> = ({ changes, onAccept, onReject, onAcceptAll, onClose }) => {
  const [activeIdx, setActiveIdx] = useState(0);

  if (changes.length === 0) return null;

  const active = changes[activeIdx];
  const diff = active ? computeDiff(active.oldContent, active.newContent) : [];
  const pendingCount = changes.filter(c => c.status === 'pending').length;

  return (
    <div className="diff-overlay">
      <div className="diff-panel">
        <div className="diff-header">
          <span>[ DIFF PREVIEW — {pendingCount} pending ]</span>
          <div className="diff-header-actions">
            <button className="diff-btn accept" onClick={onAcceptAll}>ACCEPT ALL</button>
            <button className="diff-btn close" onClick={onClose}>CLOSE</button>
          </div>
        </div>

        {/* File tabs */}
        <div className="diff-tabs">
          {changes.map((c, i) => (
            <div
              key={c.id}
              className={`diff-tab ${i === activeIdx ? 'active' : ''} ${c.status}`}
              onClick={() => setActiveIdx(i)}
            >
              {c.status === 'accepted' ? '✓' : c.status === 'rejected' ? '✗' : '●'} {c.filename}
            </div>
          ))}
        </div>

        {/* Diff content */}
        <div className="diff-content">
          {diff.map((d, i) => (
            <div key={i} className={`diff-line ${d.type}`}>
              <span className="diff-marker">
                {d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' '}
              </span>
              <span className="diff-text">{d.line}</span>
            </div>
          ))}
        </div>

        {/* Actions for current file */}
        {active && active.status === 'pending' && (
          <div className="diff-actions">
            <button className="diff-btn accept" onClick={() => onAccept(active.id)}>
              ✓ ACCEPT THIS CHANGE
            </button>
            <button className="diff-btn reject" onClick={() => onReject(active.id)}>
              ✗ REJECT
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export type { DiffChange };
