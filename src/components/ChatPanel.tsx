import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
};

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
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const streamingMsgId = useRef<string | null>(null);

  const activeConv = conversations.find(c => c.id === activeConvId)!;
  const isLoading = agentStatus !== 'idle';

  // Auto-scroll
  useEffect(() => {
    const c = scrollRef.current;
    if (c && c.scrollHeight - c.scrollTop - c.clientHeight < 200) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeConv?.messages]);

  // Setup streaming listeners
  useEffect(() => {
    if (!window.electronAPI) return;

    // Stream start: create a new empty assistant message
    window.electronAPI.onChatStreamStart(() => {
      const id = newId();
      streamingMsgId.current = id;
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvId) return conv;
        return { ...conv, messages: [...conv.messages, { id, role: 'assistant', content: '', timestamp: Date.now() }] };
      }));
    });

    // Stream token: append to the streaming message
    window.electronAPI.onChatStreamToken((token: string) => {
      const sid = streamingMsgId.current;
      if (!sid) return;
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvId) return conv;
        return {
          ...conv,
          messages: conv.messages.map(m => m.id === sid ? { ...m, content: m.content + token } : m)
        };
      }));
    });

    // Stream end
    window.electronAPI.onChatStreamEnd(() => {
      streamingMsgId.current = null;
    });

    // Non-streaming replies (tool indicators, errors)
    window.electronAPI.onChatReply((reply: string) => {
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvId) return conv;
        const msgs = [...conv.messages];
        if (reply.startsWith('\n\n> 🔧')) {
          msgs.push({ id: newId(), role: 'tool', content: reply.trim(), timestamp: Date.now() });
        } else if (reply.startsWith('\n\n❌') || reply.startsWith('\n\n⚠️') || reply.startsWith('\n\n⏳')) {
          msgs.push({ id: newId(), role: 'assistant', content: reply.trim(), timestamp: Date.now() });
        }
        return { ...conv, messages: msgs };
      }));
    });

    // Agent status
    window.electronAPI.onChatStatus((status: string) => {
      setAgentStatus(status);
    });
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
    if (!input.trim() || isLoading) return;
    let msg = input.trim();

    // Context injection
    if (currentFileContext?.content) {
      const snippet = currentFileContext.content.length > 3000
        ? currentFileContext.content.slice(0, 3000) + '\n...(truncated)'
        : currentFileContext.content;
      msg = `[CONTEXT: ${currentFileContext.path}]\n\`\`\`\n${snippet}\n\`\`\`\n\n${msg}`;
    }

    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      return { ...conv, messages: [...conv.messages, { id: newId(), role: 'user', content: input.trim(), timestamp: Date.now() }] };
    }));
    setInput('');
    if (window.electronAPI) window.electronAPI.sendChatMessage(msg);
  }, [input, isLoading, activeConvId, currentFileContext]);

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

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '50px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  const getStatusLabel = () => {
    if (agentStatus === 'thinking') return '🧠 THINKING...';
    if (agentStatus.startsWith('tool:')) return `🔧 ${agentStatus.replace('tool:', '')}`;
    return null;
  };

  return (
    <div className="chat-panel">
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              ) : (
                msg.content
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
        <div className="chat-input-wrapper">
          <textarea ref={textareaRef} className="chat-input" placeholder="ENTER COMMAND OR QUERY..."
            value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            disabled={isLoading} spellCheck="false" />
          <button className="chat-submit-btn" onClick={handleSubmit} disabled={!input.trim() || isLoading}>EXEC</button>
        </div>
      </div>
    </div>
  );
};
