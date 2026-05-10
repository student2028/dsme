/**
 * DSME Chat Message Component — Individual message bubble renderer
 *
 * Extracted from ChatPanel.tsx for single-responsibility.
 * Handles user/assistant message display, copy/edit/delete/regenerate actions.
 */

import React from 'react';
import { MemoizedMarkdown } from './MarkdownRenderer';

interface Attachment {
  type: 'file' | 'image';
  name: string;
  path?: string;
  content?: string;
  dataUrl?: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  attachments?: Attachment[];
  duration?: string;
}

function formatTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

interface ChatMessageProps {
  msg: Message;
  index: number;
  totalMessages: number;
  isLoading: boolean;
  isStreaming: boolean;
  isSearchDimmed: boolean;
  copiedMsgId: string | null;
  onCopy: (msgId: string, content: string) => void;
  onRegenerate: () => void;
  onEdit: (msgId: string, content: string) => void;
  onDelete: (msgId: string) => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  msg, index, totalMessages, isLoading, isStreaming,
  isSearchDimmed, copiedMsgId, onCopy, onRegenerate, onEdit, onDelete,
}) => {
  const isLast = index === totalMessages - 1;

  if (msg.role === 'tool') {
    return (
      <div className={`chat-message tool${isSearchDimmed ? ' search-dimmed' : ''}`}>
        <div className="tool-call-indicator">{msg.content}</div>
      </div>
    );
  }

  return (
    <div className={`chat-message ${msg.role}${isSearchDimmed ? ' search-dimmed' : ''}`}>
      <div className="chat-msg-header">
        <span className="chat-msg-role">
          <span className={`msg-avatar ${msg.role}`}>
            {msg.role === 'assistant' ? '🐬' : '●'}
          </span>
          {msg.role === 'assistant' ? 'DSME' : 'You'}
        </span>
        <div className="chat-msg-actions">
          {msg.role === 'assistant' && msg.content.trim() && (
            <button className={`chat-msg-copy${copiedMsgId === msg.id ? ' copied' : ''}`} onClick={() => onCopy(msg.id, msg.content)} title="Copy">
              {copiedMsgId === msg.id ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              )}
            </button>
          )}
          {msg.role === 'assistant' && isLast && !isLoading && msg.content.trim() && (
            <button className="chat-msg-copy" onClick={onRegenerate} title="Regenerate">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
            </button>
          )}
          {msg.role === 'user' && !isLoading && (
            <button className="chat-msg-copy" onClick={() => onEdit(msg.id, msg.content)} title="Edit">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
          )}
          {!isLoading && index > 0 && (
            <button className="chat-msg-delete" onClick={() => onDelete(msg.id)} title="删除消息">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          )}
          <span className="chat-msg-time">{formatTime(msg.timestamp)}</span>
          {msg.duration && <span className="chat-msg-duration">⚡ {msg.duration}</span>}
        </div>
      </div>
      {msg.role === 'assistant' ? (
        <MemoizedMarkdown content={msg.content} isStreaming={isStreaming} />
      ) : (
        <div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
          {msg.attachments?.filter(a => a.type === 'image' && a.dataUrl).map((a, i) => (
            <img key={i} src={a.dataUrl} alt={a.name} className="chat-attachment-preview" />
          ))}
        </div>
      )}
    </div>
  );
};
