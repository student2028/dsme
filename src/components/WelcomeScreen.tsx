import React from 'react';

// Dolphin logo mark for DSME
const LogoMark = () => (
  <div style={{
    width: 64, height: 64, borderRadius: 18,
    background: 'linear-gradient(135deg, #0ea5e9 0%, #6366f1 50%, #a855f7 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 36, boxShadow: '0 8px 32px rgba(14,165,233,0.25), 0 0 0 1px rgba(99,102,241,0.2)',
    animation: 'logoPulse 3s ease-in-out infinite',
  }}>🐬</div>
);

export const WelcomeScreen: React.FC = () => {
  return (
    <div className="welcome-screen">
      <div className="welcome-hero">
        <LogoMark />
        <div className="welcome-brand">
          <h1 className="welcome-title">DSME</h1>
          <p className="welcome-tagline">DeepSeek Matrix Engine</p>
        </div>
      </div>

      <div className="welcome-grid">
        <div className="welcome-card">
          <div className="welcome-card-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/></svg>
            <span>快捷键</span>
          </div>
          <div className="welcome-card-body">
            <div className="shortcut-row"><kbd>⌘P</kbd><span>快速打开文件</span></div>
            <div className="shortcut-row"><kbd>⌘S</kbd><span>保存文件</span></div>
            <div className="shortcut-row"><kbd>⌘B</kbd><span>切换侧边栏</span></div>
            <div className="shortcut-row"><kbd>⌘L</kbd><span>聚焦 AI 对话</span></div>
            <div className="shortcut-row"><kbd>⌘,</kbd><span>设置</span></div>
            <div className="shortcut-row"><kbd>⇧⌘L</kbd><span>切换主题</span></div>
          </div>
        </div>

        <div className="welcome-card">
          <div className="welcome-card-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            <span>AI 助手能力</span>
          </div>
          <div className="welcome-card-body">
            <div className="shortcut-row"><kbd>🔍</kbd><span>实时搜索网络信息</span></div>
            <div className="shortcut-row"><kbd>📖</kbd><span>读取和浏览项目文件</span></div>
            <div className="shortcut-row"><kbd>✏️</kbd><span>创建和编辑代码</span></div>
            <div className="shortcut-row"><kbd>⚡</kbd><span>运行终端命令</span></div>
            <div className="shortcut-row"><kbd>🖥️</kbd><span>打开浏览器采集网页</span></div>
          </div>
        </div>
      </div>

      <p className="welcome-footer">
        按 <kbd>⌘P</kbd> 打开文件，或使用侧边栏浏览项目
      </p>
    </div>
  );
};
