import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  timestamp: number;
};

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
}

let msgId = 0;
const newId = () => `msg_${Date.now()}_${msgId++}`;

export const ChatPanel: React.FC = () => {
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

  useEffect(() => {
    const container = scrollRef.current;
    if (container) {
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      if (isNearBottom) {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [activeConv?.messages]);

  useEffect(() => {
    if (!window.electronAPI) return;

    window.electronAPI.onChatReply((reply: string) => {
      setConversations(prev => prev.map(conv => {
        if (conv.id !== activeConvId) return conv;

        const msgs = [...conv.messages];
        
        if (reply.startsWith('\n\n> 🔧')) {
          msgs.push({ id: newId(), role: 'tool', content: reply.trim(), toolName: reply, timestamp: Date.now() });
        } else {
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            msgs[msgs.length - 1] = { ...lastMsg, content: lastMsg.content + reply };
          } else {
            msgs.push({ id: newId(), role: 'assistant', content: reply, timestamp: Date.now() });
          }
        }

        // Auto-title from first user message
        let title = conv.title;
        if (title === 'New Session') {
          const firstUser = msgs.find(m => m.role === 'user');
          if (firstUser) title = firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? '...' : '');
        }

        return { ...conv, messages: msgs, title };
      }));
      setIsLoading(false);
    });
  }, [activeConvId]);

  const handleSubmit = useCallback(() => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setConversations(prev => prev.map(conv => {
      if (conv.id !== activeConvId) return conv;
      return {
        ...conv,
        messages: [
          ...conv.messages,
          { id: newId(), role: 'user', content: userMessage, timestamp: Date.now() }
        ]
      };
    }));
    setInput('');
    setIsLoading(true);

    if (window.electronAPI) {
      window.electronAPI.sendChatMessage(userMessage);
    }
  }, [input, isLoading, activeConvId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleNewConversation = () => {
    const newConv: Conversation = {
      id: `conv_${Date.now()}`,
      title: 'New Session',
      messages: [
        { id: newId(), role: 'assistant', content: '> NEW SESSION INITIALIZED\n> AWAITING COMMAND...', timestamp: Date.now() }
      ],
      createdAt: Date.now()
    };
    setConversations(prev => [...prev, newConv]);
    setActiveConvId(newConv.id);
    setShowHistory(false);
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = '50px';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <span onClick={() => setShowHistory(!showHistory)} style={{ cursor: 'pointer' }}>
          {showHistory ? '◀ BACK' : '[ DEEPSEEK AGENT ]'}
        </span>
        <button className="chat-new-btn" onClick={handleNewConversation} title="New Session">+</button>
      </div>

      {showHistory ? (
        /* Conversation History List */
        <div className="chat-history-list">
          {conversations.slice().reverse().map(conv => (
            <div
              key={conv.id}
              className={`chat-history-item ${conv.id === activeConvId ? 'active' : ''}`}
              onClick={() => { setActiveConvId(conv.id); setShowHistory(false); }}
            >
              <span className="chat-history-title">{conv.title}</span>
              <span className="chat-history-count">{conv.messages.filter(m => m.role === 'user').length} msgs</span>
            </div>
          ))}
        </div>
      ) : (
        /* Active Chat */
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

      {/* Input */}
      <div className="chat-input-container">
        <div className="chat-input-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder="ENTER COMMAND OR QUERY..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            spellCheck="false"
          />
          <button
            className="chat-submit-btn"
            onClick={handleSubmit}
            disabled={!input.trim() || isLoading}
          >
            EXEC
          </button>
        </div>
      </div>
    </div>
  );
};
