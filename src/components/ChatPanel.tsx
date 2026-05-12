/**
 * DSME Chat Panel — Main orchestrator for AI conversations
 *
 * Refactored to use extracted subcomponents:
 * - MarkdownRenderer: syntax highlighting + markdown parsing
 * - ChatMessage: individual message bubbles
 * - ChatInput: message composition + attachments
 *
 * This file retains only business logic: conversation state,
 * IPC streaming, persistence, and layout orchestration.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from './Toast';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';

// ── Types ──
type Message = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  attachments?: Attachment[];
  duration?: string;
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

// ── Helpers ──
let msgId = 0;
const newId = () => `msg_${Date.now()}_${msgId++}`;

function formatTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ── Component ──
export const ChatPanel: React.FC<Props> = ({ currentFileContext }) => {
  const [conversations, setConversations] = useState<Conversation[]>([{
    id: 'conv_0', title: 'New Session',
    messages: [{ id: newId(), role: 'assistant' as const, content: '你好！有什么我可以帮你的？\n\n我能**搜索网络**、**读写文件**、**运行命令**，还能帮你写代码和调试。', timestamp: Date.now() }],
    createdAt: Date.now()
  }]);
  const [activeConvId, setActiveConvId] = useState('conv_0');
  const [input, setInput] = useState('');
  const [agentStatus, setAgentStatus] = useState<string>('idle');
  const [showHistory, setShowHistory] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [kernel, setKernel] = useState<'vercel' | 'builtin'>('vercel');
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingMsgId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamStartTime = useRef<number>(0);

  const activeConv = conversations.find(c => c.id === activeConvId) || conversations[0];
  const isLoading = agentStatus !== 'idle';

  // ── Persistence ──
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
      }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    const timer = setTimeout(() => {
      window.electronAPI.saveConversations(JSON.stringify({ conversations, activeConvId }));
    }, 1000);
    return () => clearTimeout(timer);
  }, [conversations, activeConvId]);

  // ── Auto-scroll ──
  useEffect(() => {
    const c = scrollRef.current;
    if (c) { const shouldScroll = c.scrollHeight - c.scrollTop - c.clientHeight < 200; if (shouldScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' }); }
  }, [activeConv.messages]);

  // ── Conversation switching ──
  const activeConvIdRef = useRef(activeConvId);
  useEffect(() => {
    const prev = activeConvIdRef.current;
    activeConvIdRef.current = activeConvId;
    if (prev !== activeConvId && window.electronAPI?.resetConversation) {
      window.electronAPI.resetConversation();
    }
  }, [activeConvId]);

  // ── Streaming IPC ──
  const tokenBufferRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushTokenBuffer = useCallback(() => {
    const buffered = tokenBufferRef.current;
    if (!buffered) return;
    tokenBufferRef.current = '';
    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvIdRef.current) return conv;
      return { ...conv, messages: conv.messages.map(m => m.id === streamingMsgId.current ? { ...m, content: m.content + buffered } : m) };
    }));
  }, []);

  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onChatStreamStart(() => {
      const mid = newId();
      streamingMsgId.current = mid;
      streamStartTime.current = Date.now();
      tokenBufferRef.current = '';
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvIdRef.current) return conv;
        return { ...conv, messages: [...conv.messages, { id: mid, role: 'assistant' as const, content: '', timestamp: Date.now() }] };
      }));
    });
    window.electronAPI.onChatStreamToken((token: string) => {
      if (streamingMsgId.current) {
        tokenBufferRef.current += token;
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(() => {
            flushTimerRef.current = null;
            flushTokenBuffer();
          }, 80);
        }
      }
    });
    window.electronAPI.onChatStreamEnd(() => {
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      flushTokenBuffer();
      const duration = streamStartTime.current ? ((Date.now() - streamStartTime.current) / 1000).toFixed(1) : null;
      const finishedMsgId = streamingMsgId.current;
      streamingMsgId.current = null;
      streamStartTime.current = 0;
      setAgentStatus('idle');
      if (finishedMsgId) {
        setConversations(prev => prev.map(conv => {
          if (conv.id !== activeConvIdRef.current) return conv;
          const msg = conv.messages.find(m => m.id === finishedMsgId);
          if (msg && !msg.content.trim()) {
            return {
              ...conv,
              messages: conv.messages.map(m =>
                m.id === finishedMsgId
                  ? {
                      ...m,
                      content:
                        '*（本轮未收到任何可见回复：可能已中断、流式出错，或模型在工具调用后未生成正文。请查看运行 DSME 的终端日志或重试。）*',
                    }
                  : m
              ),
            };
          }
          if (duration) {
            return { ...conv, messages: conv.messages.map(m =>
              m.id === finishedMsgId ? { ...m, duration: `${duration}s` } : m
            ) };
          }
          return conv;
        }));
      }
    });
    window.electronAPI.onChatStatus((status: string) => setAgentStatus(status));
    window.electronAPI?.onKernelChanged?.((k: string) => setKernel(k as any));
  }, [flushTokenBuffer]);

  // ── Menu shortcuts ──
  const newConvRef = useRef<() => void>(() => {});
  useEffect(() => {
    const handleFind = () => setShowSearch(s => !s);
    const handleNewConv = () => newConvRef.current();
    window.addEventListener('dsme-find', handleFind);
    window.addEventListener('dsme-new-conversation', handleNewConv);
    return () => {
      window.removeEventListener('dsme-find', handleFind);
      window.removeEventListener('dsme-new-conversation', handleNewConv);
    };
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

  // ── Actions ──
  const handleSubmit = useCallback(() => {
    if (!input.trim() && attachments.length === 0) return;
    if (isLoading) return;
    let msg = input.trim();

    let attachContext = '';
    for (const att of attachments) {
      if (att.type === 'file' && att.content) {
        attachContext += `\n[ATTACHED FILE: ${att.name}]\n\`\`\`\n${att.content.slice(0, 5000)}\n\`\`\`\n`;
      } else if (att.type === 'image' && att.dataUrl) {
        attachContext += `\n[ATTACHED IMAGE: ${att.name}]\n`;
      }
    }

    if (currentFileContext?.content) {
      const snippet = currentFileContext.content.length > 3000
        ? currentFileContext.content.slice(0, 3000) + '\n...(truncated)'
        : currentFileContext.content;
      msg = `[CONTEXT: ${currentFileContext.path}]\n\`\`\`\n${snippet}\n\`\`\`\n\n${msg}`;
    }

    if (attachContext) msg = attachContext + '\n' + msg;

    const userDisplay = input.trim() + (attachments.length > 0 ? '\n' + attachments.map(a => `[${a.name}]`).join(' ') : '');

    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      const updated = { ...conv, messages: [...conv.messages, { id: newId(), role: 'user' as const, content: userDisplay, timestamp: Date.now(), attachments }] };
      if (conv.title === 'New Session' || conv.messages.filter(m => m.role === 'user').length === 0) {
        updated.title = userDisplay.slice(0, 30) + (userDisplay.length > 30 ? '...' : '');
      }
      return updated;
    }));
    setInput('');
    setAttachments([]);

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
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (window.electronAPI?.cancelChatRequest) window.electronAPI.cancelChatRequest();
    streamingMsgId.current = null;
    setAgentStatus('idle');
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

  const handleNewConversation = () => {
    const c: Conversation = {
      id: `conv_${Date.now()}`, title: 'New Session',
      messages: [{ id: newId(), role: 'assistant' as const, content: '你好！有什么我可以帮你的？\n\n我能**搜索网络**、**读写文件**、**运行命令**，还能帮你写代码和调试。', timestamp: Date.now() }],
      createdAt: Date.now()
    };
    setConversations(prev => [...prev, c]);
    setActiveConvId(c.id);
    setShowHistory(false);
    if (window.electronAPI?.resetConversation) window.electronAPI.resetConversation();
  };
  newConvRef.current = handleNewConversation;

  const handleDeleteConversation = (e: React.MouseEvent, convId: string) => {
    e.stopPropagation();
    if (conversations.length <= 1) return;
    setConversations(prev => prev.filter(c => c.id !== convId));
    if (convId === activeConvId) {
      const remaining = conversations.filter(c => c.id !== convId);
      setActiveConvId(remaining[remaining.length - 1]?.id || '');
    }
  };

  const handleCopyMessage = (msgId: string, content: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedMsgId(msgId);
      showToast('Copied to clipboard', 'success');
      setTimeout(() => setCopiedMsgId(null), 1500);
    }).catch(() => showToast('Failed to copy', 'error'));
  };

  const handleRegenerate = useCallback(() => {
    if (isLoading) return;
    const conv = conversations.find(c => c.id === activeConvId);
    if (!conv) return;
    const msgs = [...conv.messages];
    let lastUserMsg = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { lastUserMsg = msgs[i].content; break; }
    }
    if (!lastUserMsg) return;
    while (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') { msgs.pop(); }
    setConversations(prev => prev.map(c => c.id === activeConvId ? { ...c, messages: msgs } : c));
    if (window.electronAPI) window.electronAPI.sendChatMessage(lastUserMsg);
  }, [isLoading, conversations, activeConvId]);

  const handleEditMessage = useCallback((msgId: string, content: string) => {
    setInput(content);
    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      const idx = conv.messages.findIndex(m => m.id === msgId);
      if (idx === -1) return conv;
      return { ...conv, messages: conv.messages.slice(0, idx) };
    }));
  }, [activeConvId]);

  const handleDeleteMessage = useCallback((msgId: string) => {
    if (isLoading) return;
    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      return { ...conv, messages: conv.messages.filter(m => m.id !== msgId) };
    }));
    showToast('消息已删除');
  }, [activeConvId, isLoading]);

  // Export conversation
  const exportConversation = useCallback(() => {
    const conv = activeConv;
    const date = new Date(conv.createdAt).toISOString().slice(0, 10);
    const lines = [
      `# ${conv.title}`,
      `> Exported from DSME v2.1 — ${new Date().toLocaleString()}`,
      `> Messages: ${conv.messages.length}`,
      '',
    ];
    for (const msg of conv.messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const role = msg.role === 'user' ? '👤 You' : '🐬 DSME';
      lines.push(`## ${role} — ${time}`, '', msg.content, '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dsme-${conv.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').slice(0, 40)}-${date}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Conversation exported as Markdown');
  }, [activeConv]);

  const getStatusLabel = () => {
    if (agentStatus === 'thinking') return '🧠 Thinking...';
    if (agentStatus.startsWith('tool:')) {
      const tool = agentStatus.replace('tool:', '');
      const labels: Record<string, string> = {
        web_search: '🔍 Searching...', fetch_url: '🌐 Reading page...', browse_page: '🖥️ Browsing...',
        read_file: '📖 Reading file...', write_file: '✏️ Writing file...', replace_in_file: '🔧 Editing file...',
        list_directory: '📁 Listing files...', search_codebase: '🔎 Searching code...', run_command: '⚡ Running command...',
      };
      return labels[tool] || `⚙️ ${tool}`;
    }
    return null;
  };

  // ── Drag handlers ──
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDropWithState = (_e: React.DragEvent) => { setIsDragOver(false); };

  // ── Render ──
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
            <span className="chat-kernel-toggle"
              title={`Current: ${kernel === 'vercel' ? 'Vercel AI SDK' : 'Built-in'} — Click to switch`}
              onClick={() => {
                const next = kernel === 'vercel' ? 'builtin' : 'vercel';
                setKernel(next);
                window.electronAPI?.switchKernel(next);
              }}
              style={{ cursor: 'pointer' }}
            >
              {kernel === 'vercel' ? '⚡ VERCEL' : '🔧 BUILTIN'}
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
          <button className="chat-export-btn" onClick={exportConversation} title="导出对话为 Markdown" aria-label="Export conversation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button className={`chat-export-btn${showSearch ? ' active' : ''}`} onClick={() => { setShowSearch(s => !s); if (showSearch) setSearchQuery(''); }} title="搜索消息" aria-label="Search messages">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          <button className="chat-new-btn" onClick={handleNewConversation} title="New conversation (⌘N)" aria-label="New conversation">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="chat-search-bar">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input className="chat-search-input" type="text" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); } }}
            placeholder="搜索消息..." autoFocus
          />
          <span className="chat-search-count">
            {searchQuery ? `${activeConv.messages.filter(m => m.content.toLowerCase().includes(searchQuery.toLowerCase())).length} 匹配` : ''}
          </span>
          <button className="chat-search-close" onClick={() => { setShowSearch(false); setSearchQuery(''); }}>×</button>
        </div>
      )}

      {/* History / Messages */}
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
                {lastMsg && <div className="chat-history-preview">{lastMsg.content.slice(0, 50)}</div>}
              </div>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                <span className="chat-history-time">{formatTime(conv.createdAt)}</span>
                <span className="chat-history-count">{userMsgs.length}</span>
                {conversations.length > 1 && (
                  <span className="chat-history-delete" onClick={e => handleDeleteConversation(e, conv.id)} title="Delete">×</span>
                )}
              </div>
            </div>
          );
          })}
        </div>
      ) : (
        <div className="chat-history" ref={scrollRef}>
          {activeConv.messages.map((msg, i) => {
            const isSearchMatch = !searchQuery.trim() || msg.content.toLowerCase().includes(searchQuery.trim().toLowerCase());
            return (
              <ChatMessage
                key={msg.id}
                msg={msg}
                index={i}
                totalMessages={activeConv.messages.length}
                isLoading={isLoading}
                isStreaming={streamingMsgId.current === msg.id}
                isSearchDimmed={!!searchQuery.trim() && !isSearchMatch}
                copiedMsgId={copiedMsgId}
                onCopy={handleCopyMessage}
                onRegenerate={handleRegenerate}
                onEdit={handleEditMessage}
                onDelete={handleDeleteMessage}
              />
            );
          })}
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

      <ChatInput
        input={input}
        setInput={setInput}
        isLoading={isLoading}
        attachments={attachments}
        setAttachments={setAttachments}
        hasUserMessages={activeConv.messages.filter(m => m.role === 'user').length > 0}
        onSubmit={handleSubmit}
        onStop={handleStop}
      />
    </div>
  );
};
