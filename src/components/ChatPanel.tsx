import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { showToast } from './Toast';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import kotlin from 'highlight.js/lib/languages/kotlin';
import dart from 'highlight.js/lib/languages/dart';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import swift from 'highlight.js/lib/languages/swift';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('kt', kotlin);
hljs.registerLanguage('dart', dart);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('rs', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('swift', swift);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('diff', diff);

// Configure marked with syntax highlighting
marked.setOptions({
  breaks: true,
  gfm: true,
});

const renderer = new marked.Renderer();
renderer.code = function({ text, lang }: { text: string; lang?: string }) {
  let highlighted = text;
  const language = lang || '';
  try {
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }
  } catch {}
  // Add line numbers
  const lines = highlighted.split('\n');
  const numberedLines = lines.map((line, i) =>
    `<span class="code-line"><span class="line-num">${i + 1}</span>${line}</span>`
  ).join('\n');
  // Encode code as Base64 for safe HTML attribute storage (prevents XSS)
  const b64 = btoa(unescape(encodeURIComponent(text)));
  const lineCount = lines.length;
  return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${language || 'code'}</span><span class="md-code-lines">${lineCount} lines</span><button class="md-code-copy" data-code="${b64}" onclick="try{var t=decodeURIComponent(escape(atob(this.getAttribute('data-code'))));navigator.clipboard.writeText(t);this.textContent='✓ Copied';this.classList.add('copied');setTimeout(()=>{this.textContent='Copy';this.classList.remove('copied')},2000)}catch(e){this.textContent='✗ Failed'}">Copy</button></div><pre><code class="hljs has-line-numbers">${numberedLines}</code></pre></div>`;
};
marked.use({ renderer });

function renderMarkdown(content: string): string {
  try { return marked.parse(content) as string; }
  catch { return content; }
}

// Memoized markdown renderer — prevents re-parsing unchanged messages during streaming
const MemoizedMarkdown = React.memo(({ content, isStreaming }: { content: string; isStreaming: boolean }) => {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className={`md-content${isStreaming ? ' streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}, (prev, next) => prev.content === next.content && prev.isStreaming === next.isStreaming);

function formatTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  attachments?: Attachment[];
};

interface Attachment {
  type: 'file' | 'image';
  name: string;
  path?: string;
  content?: string;
  dataUrl?: string;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

interface Props {
  currentFileContext?: { path: string; content: string } | null;
}

let msgId = 0;
const newId = () => `msg_${Date.now()}_${msgId++}`;

export const ChatPanel: React.FC<Props> = ({ currentFileContext }) => {
  const [conversations, setConversations] = useState<Conversation[]>([{
    id: 'conv_0', title: 'New Session',
    messages: [{ id: newId(), role: 'assistant' as const, content: 'New session started. How can I help you?', timestamp: Date.now() }],
    createdAt: Date.now()
  }]);
  const [activeConvId, setActiveConvId] = useState('conv_0');
  const [input, setInput] = useState('');
  const [agentStatus, setAgentStatus] = useState<string>('idle');
  const [showHistory, setShowHistory] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamingMsgId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const activeConv = conversations.find(c => c.id === activeConvId) || conversations[0];
  const isLoading = agentStatus !== 'idle';

  // Load conversations from disk
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.loadConversations().then(data => {
        if (data) {
          try {
            const saved = JSON.parse(data);
            if (saved.conversations?.length > 0) {
              setConversations(saved.conversations);
              setActiveConvId(saved.activeConvId || saved.conversations[0].id);
            }
          } catch {}
        }
      });
    }
  }, []);

  // Save conversations
  useEffect(() => {
    if (!window.electronAPI) return;
    const timer = setTimeout(() => {
      window.electronAPI.saveConversations(JSON.stringify({ conversations, activeConvId }));
    }, 1000);
    return () => clearTimeout(timer);
  }, [conversations, activeConvId]);

  // Auto-scroll
  useEffect(() => {
    const c = scrollRef.current;
    if (c) { const shouldScroll = c.scrollHeight - c.scrollTop - c.clientHeight < 200; if (shouldScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' }); }
  }, [activeConv.messages]);

  // Track activeConvId in a ref so IPC callbacks always see the latest value
  const activeConvIdRef = useRef(activeConvId);
  useEffect(() => {
    const prev = activeConvIdRef.current;
    activeConvIdRef.current = activeConvId;
    // When switching conversations, reset backend context to prevent cross-talk
    if (prev !== activeConvId && window.electronAPI?.resetConversation) {
      window.electronAPI.resetConversation();
    }
  }, [activeConvId]);

  // Streaming IPC — register ONCE
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onChatStreamStart(() => {
      const mid = newId();
      streamingMsgId.current = mid;
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvIdRef.current) return conv;
        return { ...conv, messages: [...conv.messages, { id: mid, role: 'assistant' as const, content: '', timestamp: Date.now() }] };
      }));
    });
    window.electronAPI.onChatStreamToken((token: string) => {
      if (streamingMsgId.current) {
        setConversations(prev => prev.map(conv => {
          if (conv.id !== activeConvIdRef.current) return conv;
          return { ...conv, messages: conv.messages.map(m => m.id === streamingMsgId.current ? { ...m, content: m.content + token } : m) };
        }));
      }
    });
    window.electronAPI.onChatStreamEnd(() => { streamingMsgId.current = null; setAgentStatus('idle'); });
    window.electronAPI.onChatStatus((status: string) => setAgentStatus(status));
  }, []);

  // Auto-title
  useEffect(() => {
    if (activeConv.title === 'New Session') {
      const firstUser = activeConv.messages.find(m => m.role === 'user');
      if (firstUser) {
        setConversations(prev => prev.map(c =>
          c.id === activeConvId ? { ...c, title: firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '...' : '') } : c
        ));
      }
    }
  }, [activeConv.messages]);

  const handleSubmit = useCallback(() => {
    if (!input.trim() && attachments.length === 0) return;
    if (isLoading) return;
    let msg = input.trim();

    // Build attachment context
    let attachContext = '';
    for (const att of attachments) {
      if (att.type === 'file' && att.content) {
        attachContext += `\n[ATTACHED FILE: ${att.name}]\n\`\`\`\n${att.content.slice(0, 5000)}\n\`\`\`\n`;
      } else if (att.type === 'image' && att.dataUrl) {
        attachContext += `\n[ATTACHED IMAGE: ${att.name}]\n`;
      }
    }

    // Context injection
    if (currentFileContext?.content) {
      const snippet = currentFileContext.content.length > 3000
        ? currentFileContext.content.slice(0, 3000) + '\n...(truncated)'
        : currentFileContext.content;
      msg = `[CONTEXT: ${currentFileContext.path}]\n\`\`\`\n${snippet}\n\`\`\`\n\n${msg}`;
    }

    if (attachContext) msg = attachContext + '\n' + msg;

    // Show user message with attachment indicators
    const userDisplay = input.trim() + (attachments.length > 0 ? '\n' + attachments.map(a => `[${a.name}]`).join(' ') : '');

    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      const updated = { ...conv, messages: [...conv.messages, { id: newId(), role: 'user' as const, content: userDisplay, timestamp: Date.now(), attachments }] };
      // Auto-title from first user message
      if (conv.title === 'New Session' || conv.messages.filter(m => m.role === 'user').length === 0) {
        updated.title = userDisplay.slice(0, 30) + (userDisplay.length > 30 ? '...' : '');
      }
      return updated;
    }));
    setInput('');
    setAttachments([]);
    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    // Send images as separate data for multimodal API support
    const imageDataUrls = attachments.filter(a => a.type === 'image' && a.dataUrl).map(a => a.dataUrl!);
    if (window.electronAPI) {
      if (imageDataUrls.length > 0 && window.electronAPI.sendChatMessageWithImages) {
        window.electronAPI.sendChatMessageWithImages(msg, imageDataUrls);
      } else {
        window.electronAPI.sendChatMessage(msg);
      }
    }
  }, [input, isLoading, activeConvId, currentFileContext, attachments]);

  const handleStop = useCallback(() => {
    // Abort the current request
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // Tell backend to cancel
    if (window.electronAPI?.cancelChatRequest) {
      window.electronAPI.cancelChatRequest();
    }
    // Reset state
    streamingMsgId.current = null;
    setAgentStatus('idle');
    // Add a note to the last message
    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      const msgs = [...conv.messages];
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
        msgs[msgs.length - 1] = { ...lastMsg, content: lastMsg.content + '\n\n*— Request stopped*' };
      }
      return { ...conv, messages: msgs };
    }));
  }, [activeConvId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleNewConversation = () => {
    const c: Conversation = {
      id: `conv_${Date.now()}`, title: 'New Session',
      messages: [{ id: newId(), role: 'assistant' as const, content: 'Hi! How can I help you today? \n\nI can **search the web**, **read/write files**, **run commands**, and help with coding tasks.', timestamp: Date.now() }],
      createdAt: Date.now()
    };
    setConversations(prev => [...prev, c]);
    setActiveConvId(c.id);
    setShowHistory(false);
    // Reset the agent conversation
    if (window.electronAPI?.resetConversation) window.electronAPI.resetConversation();
  };

  const handleDeleteConversation = (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    if (conversations.length <= 1) return; // keep at least one
    setConversations(prev => prev.filter(c => c.id !== convId));
    if (convId === activeConvId) {
      const remaining = conversations.filter(c => c.id !== convId);
      setActiveConvId(remaining[remaining.length - 1]?.id || '');
    }
  };

  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const handleCopyMessage = (msgId: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedMsgId(msgId);
      showToast('Copied to clipboard', 'success');
      setTimeout(() => setCopiedMsgId(null), 1500);
    });
  };

  // Regenerate last AI response
  const handleRegenerate = useCallback(() => {
    if (isLoading) return;
    const conv = conversations.find(c => c.id === activeConvId);
    if (!conv) return;
    // Find last user message
    const msgs = [...conv.messages];
    let lastUserMsg = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUserMsg = msgs[i].content; break; }
    }
    if (!lastUserMsg) return;
    // Remove last assistant message
    while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
      msgs.pop();
    }
    setConversations(prev => prev.map(c => c.id === activeConvId ? { ...c, messages: msgs } : c));
    // Resend
    if (window.electronAPI) window.electronAPI.sendChatMessage(lastUserMsg);
  }, [isLoading, conversations, activeConvId]);

  // Edit a user message (put it back in input)
  const handleEditMessage = useCallback((msgId: string, content: string) => {
    setInput(content);
    textareaRef.current?.focus();
    // Remove this message and all subsequent messages
    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      const idx = conv.messages.findIndex(m => m.id === msgId);
      if (idx === -1) return conv;
      return { ...conv, messages: conv.messages.slice(0, idx) };
    }));
  }, [activeConvId]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '50px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  // Cmd+L focus chat input
  useEffect(() => {
    const handler = () => textareaRef.current?.focus();
    window.addEventListener('focus-chat', handler);
    return () => window.removeEventListener('focus-chat', handler);
  }, []);

  // File drop handler
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          setAttachments(prev => [...prev, { type: 'image', name: file.name, dataUrl: reader.result as string }]);
        };
        reader.readAsDataURL(file);
      } else {
        const reader = new FileReader();
        reader.onload = () => {
          setAttachments(prev => [...prev, { type: 'file', name: file.name, content: reader.result as string }]);
        };
        reader.readAsText(file);
      }
    }
  }, []);

  // Paste image handler
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = () => {
            setAttachments(prev => [...prev, { type: 'image', name: `screenshot_${Date.now()}.png`, dataUrl: reader.result as string }]);
          };
          reader.readAsDataURL(blob);
        }
      }
    }
  }, []);

  // File input handler
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

  const getStatusLabel = () => {
    if (agentStatus === 'thinking') return '🧠 Thinking...';
    if (agentStatus.startsWith('tool:')) {
      const tool = agentStatus.replace('tool:', '');
      const labels: Record<string, string> = {
        web_search: '🔍 Searching...',
        fetch_url: '🌐 Reading page...',
        read_file: '📖 Reading file...',
        write_file: '✏️ Writing file...',
        replace_in_file: '🔧 Editing file...',
        list_directory: '📁 Listing files...',
        search_codebase: '🔎 Searching code...',
        run_command: '⚡ Running command...',
      };
      return labels[tool] || `⚙️ ${tool}`;
    }
    return null;
  };

  // Drag visual feedback
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDropWithState = (e: React.DragEvent) => {
    setIsDragOver(false);
    handleDrop(e);
  };

  // SVG Send icon
  const SendIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );

  return (
    <div className={`chat-panel ${isDragOver ? 'drag-over' : ''}`}
         role="complementary" aria-label="AI Chat Panel"
         onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDropWithState}>
      <div className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="chat-header-title" onClick={showHistory ? () => setShowHistory(false) : undefined} style={{ cursor: showHistory ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: '6px' }}>
            {showHistory ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
                Back
              </>
            ) : (
              <>🐬 AI Chat</>
            )}
          </span>
          {!showHistory && (
            <span className="chat-kernel-toggle" title="Vercel AI SDK Engine">
              ⚡ VERCEL
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {currentFileContext && (
            <span className="ctx-indicator" title={currentFileContext.path}>{currentFileContext.path.split('/').pop()}</span>
          )}
          {getStatusLabel() && <span className="agent-status-badge">{getStatusLabel()}</span>}
          <button className={`chat-history-btn ${showHistory ? 'active' : ''}`} onClick={() => setShowHistory(!showHistory)} title={`会话历史 (${conversations.length})`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </button>
          <button className="chat-new-btn" onClick={handleNewConversation} title="New conversation (⌘N)" aria-label="New conversation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
      </div>

      {showHistory ? (
        <div className="chat-history-list">
          <div className="chat-history-header">最近会话 ({Math.min(conversations.length, 10)}/{conversations.length})</div>
          {conversations.slice().reverse().slice(0, 10).map(conv => {
            const userMsgs = conv.messages.filter(m => m.role === 'user');
            const lastMsg = userMsgs[userMsgs.length - 1];
            return (
            <div key={conv.id} className={`chat-history-item ${conv.id === activeConvId ? 'active' : ''}`}
                 onClick={() => { setActiveConvId(conv.id); setShowHistory(false); }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className="chat-history-title">{conv.title}</span>
                {lastMsg && (
                  <div className="chat-history-preview">{lastMsg.content.slice(0, 50)}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                <span className="chat-history-time">{formatTime(conv.createdAt)}</span>
                <span className="chat-history-count">{userMsgs.length}</span>
                {conversations.length > 1 && (
                  <span className="chat-history-delete" onClick={e => handleDeleteConversation(e, conv.id)} title="Delete">×</span>
                )}
              </div>
            </div>
          );})}
        </div>
      ) : (
        <div className="chat-history" ref={scrollRef}>
          {activeConv.messages.map((msg, i) => (
            <div key={msg.id} className={`chat-message ${msg.role}`}>
              {msg.role === 'tool' ? (
                <div className="tool-call-indicator">{msg.content}</div>
              ) : (
                <>
                  <div className="chat-msg-header">
                    <span className="chat-msg-role">
                      <span className={`msg-avatar ${msg.role}`}>
                        {msg.role === 'assistant' ? '🐬' : '●'}
                      </span>
                      {msg.role === 'assistant' ? 'DSME' : 'You'}
                    </span>
                    <div className="chat-msg-actions">
                      {msg.role === 'assistant' && msg.content.trim() && (
                        <button className={`chat-msg-copy${copiedMsgId === msg.id ? ' copied' : ''}`} onClick={() => handleCopyMessage(msg.id, msg.content)} title="Copy">
                          {copiedMsgId === msg.id ? (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                          ) : (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                          )}
                        </button>
                      )}
                      {msg.role === 'assistant' && i === activeConv.messages.length - 1 && !isLoading && msg.content.trim() && (
                        <button className="chat-msg-copy" onClick={handleRegenerate} title="Regenerate">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>
                        </button>
                      )}
                      {msg.role === 'user' && !isLoading && (
                        <button className="chat-msg-copy" onClick={() => handleEditMessage(msg.id, msg.content)} title="Edit">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                      )}
                      <span className="chat-msg-time">{formatTime(msg.timestamp)}</span>
                    </div>
                  </div>
                  {msg.role === 'assistant' ? (
                    <MemoizedMarkdown content={msg.content} isStreaming={streamingMsgId.current === msg.id} />
                  ) : (
                    <div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                      {msg.attachments?.filter(a => a.type === 'image' && a.dataUrl).map((a, i) => (
                        <img key={i} src={a.dataUrl} alt={a.name} className="chat-attachment-preview" />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {isLoading && !streamingMsgId.current && (
            <div className="chat-message assistant loader">
              <div className="chat-loading-content">
                <div className="typing-indicator">
                  <span></span><span></span><span></span>
                </div>
                <span className="loading-label">{getStatusLabel() || '🧠 Thinking...'}</span>
              </div>
              <div className="chat-progress-bar"><div className="chat-progress-fill" /></div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="chat-input-container">
        {/* Quick suggestions for new conversations */}
        {activeConv.messages.filter(m => m.role === 'user').length === 0 && !isLoading && (
          <div className="chat-suggestions">
            {[
              { icon: '📂', text: '分析项目结构' },
              { icon: '🔍', text: '搜索最新科技新闻' },
              { icon: '🐛', text: '帮我调试代码' },
              { icon: '⚡', text: '写一个快速脚本' },
            ].map(s => (
              <button key={s.text} className="chat-suggestion-chip" onClick={() => { setInput(s.text); }}>
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
              // Auto-resize textarea
              const ta = e.target;
              ta.style.height = 'auto';
              ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
            }} onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={isLoading} spellCheck="false" rows={1} />
          <button className="chat-submit-btn" onClick={handleSubmit} disabled={(!input.trim() && attachments.length === 0) || isLoading}
            title="Send message" aria-label="Send message" style={{ display: isLoading ? 'none' : undefined }}>
            <SendIcon />
          </button>
          {isLoading && (
            <button className="chat-stop-btn" onClick={handleStop} title="Stop generating" aria-label="Stop generating">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
