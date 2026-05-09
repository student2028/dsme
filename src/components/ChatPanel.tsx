import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${language || 'code'}</span><button class="md-code-copy" onclick="navigator.clipboard.writeText(this.closest('.md-code-block').querySelector('code').textContent)">📋 Copy</button></div><pre><code class="hljs">${highlighted}</code></pre></div>`;
};
marked.use({ renderer });

function renderMarkdown(content: string): string {
  try { return marked.parse(content) as string; }
  catch { return content; }
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
    messages: [{ id: newId(), role: 'assistant', content: '> SYSTEM INITIALIZED\n> DEEPSEEK AGENT READY\n> AWAITING COMMAND...', timestamp: Date.now() }],
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

  const activeConv = conversations.find(c => c.id === activeConvId)!;
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

  // Streaming IPC
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onChatReply((text: string) => {
      if (streamingMsgId.current) {
        setConversations(prev => prev.map(conv => {
          if (conv.id !== activeConvId) return conv;
          return { ...conv, messages: conv.messages.map(m => m.id === streamingMsgId.current ? { ...m, content: m.content + text } : m) };
        }));
      }
    });
    window.electronAPI.onChatStreamStart(() => {
      const mid = newId();
      streamingMsgId.current = mid;
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvId) return conv;
        return { ...conv, messages: [...conv.messages, { id: mid, role: 'assistant', content: '', timestamp: Date.now() }] };
      }));
    });
    window.electronAPI.onChatStreamToken((token: string) => {
      if (streamingMsgId.current) {
        setConversations(prev => prev.map(conv => {
          if (conv.id !== activeConvId) return conv;
          return { ...conv, messages: conv.messages.map(m => m.id === streamingMsgId.current ? { ...m, content: m.content + token } : m) };
        }));
      }
    });
    window.electronAPI.onChatStreamEnd(() => { streamingMsgId.current = null; });
    window.electronAPI.onChatStatus((status: string) => setAgentStatus(status));
  }, [activeConvId]);

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
    const userDisplay = input.trim() + (attachments.length > 0 ? '\n' + attachments.map(a => `📎 ${a.name}`).join('\n') : '');

    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      return { ...conv, messages: [...conv.messages, { id: newId(), role: 'user', content: userDisplay, timestamp: Date.now(), attachments }] };
    }));
    setInput('');
    setAttachments([]);
    if (window.electronAPI) window.electronAPI.sendChatMessage(msg);
  }, [input, isLoading, activeConvId, currentFileContext, attachments]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleNewConversation = () => {
    const c: Conversation = {
      id: `conv_${Date.now()}`, title: 'New Session',
      messages: [{ id: newId(), role: 'assistant', content: '> NEW SESSION\n> AWAITING COMMAND...', timestamp: Date.now() }],
      createdAt: Date.now()
    };
    setConversations(prev => [...prev, c]);
    setActiveConvId(c.id);
    setShowHistory(false);
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '50px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

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
    if (agentStatus === 'thinking') return '🧠 THINKING...';
    if (agentStatus.startsWith('tool:')) return `🔧 ${agentStatus.replace('tool:', '')}`;
    return null;
  };

  return (
    <div className="chat-panel" onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={handleDrop}>
      <div className="chat-header">
        <span onClick={() => setShowHistory(!showHistory)} style={{ cursor: 'pointer' }}>
          {showHistory ? '◀ BACK' : '[ DEEPSEEK AGENT ]'}
        </span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {currentFileContext && (
            <span className="ctx-indicator">CTX: {currentFileContext.path.split('/').pop()}</span>
          )}
          {getStatusLabel() && <span className="agent-status-badge">{getStatusLabel()}</span>}
          <button className="chat-new-btn" onClick={handleNewConversation} title="New Session">+</button>
        </div>
      </div>

      {showHistory ? (
        <div className="chat-history-list">
          {conversations.slice().reverse().map(conv => (
            <div key={conv.id} className={`chat-history-item ${conv.id === activeConvId ? 'active' : ''}`}
                 onClick={() => { setActiveConvId(conv.id); setShowHistory(false); }}>
              <span className="chat-history-title">{conv.title}</span>
              <span className="chat-history-count">{conv.messages.filter(m => m.role === 'user').length} msgs</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="chat-history" ref={scrollRef}>
          {activeConv.messages.map((msg) => (
            <div key={msg.id} className={`chat-message ${msg.role}`}>
              {msg.role === 'tool' ? (
                <div className="tool-call-indicator">{msg.content}</div>
              ) : msg.role === 'assistant' ? (
                <div className="md-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
              ) : (
                <div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                  {msg.attachments?.filter(a => a.type === 'image' && a.dataUrl).map((a, i) => (
                    <img key={i} src={a.dataUrl} alt={a.name} className="chat-attachment-preview" />
                  ))}
                </div>
              )}
            </div>
          ))}
          {isLoading && !streamingMsgId.current && (
            <div className="chat-message assistant loader">
              <span className="loading-bar">▓▓▓▓▓▓▓▓░░░░ {getStatusLabel() || 'PROCESSING...'}</span>
            </div>
          )}
          <div ref={endRef} />
        </div>
      )}

      <div className="chat-input-container">
        {/* Attachment preview */}
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((att, i) => (
              <div key={i} className="chat-attachment-chip">
                <span>{att.type === 'image' ? '🖼' : '📄'} {att.name}</span>
                <span className="chat-attachment-remove" onClick={() => removeAttachment(i)}>×</span>
              </div>
            ))}
          </div>
        )}
        <div className="chat-input-wrapper">
          <button className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} title="Attach file or image">📎</button>
          <input ref={fileInputRef} type="file" style={{ display: 'none' }} multiple onChange={handleFileSelect} accept="*/*" />
          <textarea ref={textareaRef} className="chat-input" placeholder="Ask anything... (Shift+Enter for newline, drag/paste images)"
            value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={isLoading} spellCheck="false" />
          <button className="chat-submit-btn" onClick={handleSubmit} disabled={(!input.trim() && attachments.length === 0) || isLoading}>
            {isLoading ? '...' : '▶'}
          </button>
        </div>
      </div>
    </div>
  );
};
