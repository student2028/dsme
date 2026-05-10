/**
 * DSME Chat Input — Message composition area
 *
 * Extracted from ChatPanel.tsx. Handles:
 * - Text input with auto-resize
 * - File/image attachments (drag, paste, file picker)
 * - Quick suggestion chips
 * - Send/Stop controls
 * - Character/token counter
 */

import React, { useCallback, useEffect, useRef } from 'react';

interface Attachment {
  type: 'file' | 'image';
  name: string;
  path?: string;
  content?: string;
  dataUrl?: string;
}

interface ChatInputProps {
  input: string;
  setInput: (v: string) => void;
  isLoading: boolean;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  hasUserMessages: boolean;
  onSubmit: () => void;
  onStop: () => void;
}

// SVG Send icon
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
);

export const ChatInput: React.FC<ChatInputProps> = ({
  input, setInput, isLoading, attachments, setAttachments,
  hasUserMessages, onSubmit, onStop,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '50px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  // Cmd+L focus
  useEffect(() => {
    const handler = () => textareaRef.current?.focus();
    window.addEventListener('focus-chat', handler);
    return () => window.removeEventListener('focus-chat', handler);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); }
  };

  // File drop handler — used by textarea onDrop
  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => setAttachments(prev => [...prev, { type: 'image', name: file.name, dataUrl: reader.result as string }]);
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => setAttachments(prev => [...prev, { type: 'file', name: file.name, content: reader.result as string }]);
        reader.readAsText(file);
      }
    }
  }, [setAttachments]);

  // Paste image
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = () => setAttachments(prev => [...prev, { type: 'image', name: `screenshot_${Date.now()}.png`, dataUrl: reader.result as string }]);
          reader.readAsDataURL(blob);
        }
      }
    }
  }, [setAttachments]);

  // File picker
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => setAttachments(prev => [...prev, { type: 'image', name: file.name, dataUrl: reader.result as string }]);
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => setAttachments(prev => [...prev, { type: 'file', name: file.name, content: reader.result as string }]);
        reader.readAsText(file);
      }
    }
    e.target.value = '';
  };

  const removeAttachment = (idx: number) => setAttachments(prev => prev.filter((_, i) => i !== idx));

  const SUGGESTIONS = [
    { icon: '📂', text: '分析项目结构' },
    { icon: '🔍', text: '搜索最新科技新闻' },
    { icon: '🐛', text: '帮我调试代码' },
    { icon: '⚡', text: '写一个快速脚本' },
  ];

  return (
    <div className="chat-input-container" onDrop={handleFileDrop} onDragOver={e => e.preventDefault()}>
      {/* Quick suggestions for new conversations */}
      {!hasUserMessages && !isLoading && (
        <div className="chat-suggestions">
          {SUGGESTIONS.map(s => (
            <button key={s.text} className="chat-suggestion-chip" onClick={() => setInput(s.text)}>
              <span className="suggestion-icon">{s.icon}</span>
              {s.text}
            </button>
          ))}
        </div>
      )}

      {/* Attachment preview */}
      {attachments.length > 0 && (
        <div className="chat-attachments">
          {attachments.map((att, i) => (
            <div key={i} className="chat-attachment-chip">
              <span>{att.name}</span>
              <span className="chat-attachment-remove" onClick={() => removeAttachment(i)}>×</span>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input-wrapper">
        <button className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach file" aria-label="Attach file">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} multiple onChange={handleFileSelect} accept="*/*" />
        <textarea ref={textareaRef} className="chat-input" placeholder="Ask anything... ⏎ Send · ⇧⏎ New line"
          aria-label="Chat message input"
          value={input} onChange={(e) => {
            setInput(e.target.value);
            const ta = e.target;
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
          }} onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={isLoading} spellCheck="false" rows={1} />
        <button className="chat-submit-btn" onClick={onSubmit} disabled={(!input.trim() && attachments.length === 0) || isLoading}
          title="Send message" aria-label="Send message" style={{ display: isLoading ? 'none' : undefined }}>
          <SendIcon />
        </button>
        {isLoading && (
          <button className="chat-stop-btn" onClick={onStop} title="Stop generating" aria-label="Stop generating">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          </button>
        )}
      </div>
      {input.length > 50 && (
        <div className="chat-input-stats">
          <span>{input.length} 字符</span>
          <span>~{Math.ceil(input.length / 3.5)} tokens</span>
        </div>
      )}
    </div>
  );
};
