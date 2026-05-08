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
    id: 'conv_0',
    title: 'New Session',
    messages: [
      { id: newId(), role: 'assistant', content: '> SYSTEM INITIALIZED\n> DEEPSEEK AGENT READY\n> TOOLS: read_file, write_file, replace, grep, shell\n> AWAITING COMMAND...', timestamp: Date.now() }
    ],
    createdAt: Date.now()
  }]);
  const [activeConvId, setActiveConvId] = useState('conv_0');
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeConv = conversations.find(c => c.id === activeConvId)!;

  // Auto-scroll
  useEffect(() => {
    const container = scrollRef.current;
    if (container) {
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      if (isNearBottom) endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeConv?.messages]);

  // Listen for agent replies
  useEffect(() => {
    if (!window.electronAPI) return;

    const handler = (reply: string) => {
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvId) return conv;
        const msgs = [...conv.messages];

        if (reply.startsWith('\n\n> 🔧')) {
          msgs.push({ id: newId(), role: 'tool', content: reply.trim(), timestamp: Date.now() });
        } else {
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && !reply.startsWith('\n\n')) {
            // Append to existing assistant message (streaming)
            msgs[msgs.length - 1] = { ...lastMsg, content: lastMsg.content + reply };
          } else {
            msgs.push({ id: newId(), role: 'assistant', content: reply.replace(/^\n\n/, ''), timestamp: Date.now() });
          }
        }

        let title = conv.title;
        if (title === 'New Session') {
          const firstUser = msgs.find(m => m.role === 'user');
          if (firstUser) title = firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '...' : '');
        }

        return { ...conv, messages: msgs, title };
      }));
      setIsLoading(false);
    };

    window.electronAPI.onChatReply(handler);
    // Note: ipcRenderer.on doesn't return unsubscribe, so we don't clean up here
    // This is a known limitation; in production we'd use removeListener
  }, [activeConvId]);

  const handleSubmit = useCallback(() => {
    if (!input.trim() || isLoading) return;

    let userMessage = input.trim();

    // Context injection: if the user has a file open, auto-attach it
    if (currentFileContext && currentFileContext.content) {
      const ctx = currentFileContext;
      const snippet = ctx.content.length > 3000 ? ctx.content.slice(0, 3000) + '\n... (truncated)' : ctx.content;
      userMessage = `[CONTEXT: Currently editing ${ctx.path}]\n\`\`\`\n${snippet}\n\`\`\`\n\n${userMessage}`;
    }

    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      return {
        ...conv,
        messages: [
          ...conv.messages,
          { id: newId(), role: 'user', content: input.trim(), timestamp: Date.now() } // Show original (not injected context) in UI
        ]
      };
    }));
    setInput('');
    setIsLoading(true);

    if (window.electronAPI) {
      window.electronAPI.sendChatMessage(userMessage); // Send the context-enriched version to agent
    }
  }, [input, isLoading, activeConvId, currentFileContext]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const handleNewConversation = () => {
    const c: Conversation = {
      id: `conv_${Date.now()}`,
      title: 'New Session',
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

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span onClick={() => setShowHistory(!showHistory)} style={{ cursor: 'pointer' }}>
          {showHistory ? '◀ BACK' : '[ DEEPSEEK AGENT ]'}
        </span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {currentFileContext && (
            <span style={{ fontSize: '10px', color: 'var(--cyan)', opacity: 0.7 }}>
              CTX: {currentFileContext.path.split('/').pop()}
            </span>
          )}
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
          {isLoading && <div className="chat-message assistant loader">
            <span className="loading-bar">▓▓▓▓▓▓▓▓░░░░ PROCESSING...</span>
          </div>}
          <div ref={endRef} />
        </div>
      )}

      <div className="chat-input-container">
        <div className="chat-input-wrapper">
          <textarea ref={textareaRef} className="chat-input" placeholder="ENTER COMMAND OR QUERY..."
            value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            disabled={isLoading} spellCheck="false" />
          <button className="chat-submit-btn" onClick={handleSubmit}
            disabled={!input.trim() || isLoading}>EXEC</button>
        </div>
      </div>
    </div>
  );
};
