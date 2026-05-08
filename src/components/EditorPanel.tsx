import React, { useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';

interface Props {
  content: string;
  onChange: (value: string | undefined) => void;
  filename: string;
  onCursorChange?: (line: number, column: number) => void;
}

export const EditorPanel: React.FC<Props> = ({ content, onChange, filename, onCursorChange }) => {
  const editorRef = useRef<any>(null);

  const getLanguage = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      'ts': 'typescript', 'tsx': 'typescript',
      'js': 'javascript', 'jsx': 'javascript',
      'css': 'css', 'html': 'html', 'json': 'json',
      'md': 'markdown', 'py': 'python', 'rs': 'rust',
      'go': 'go', 'java': 'java', 'kt': 'kotlin',
      'swift': 'swift', 'sh': 'shell', 'bash': 'shell',
      'yaml': 'yaml', 'yml': 'yaml', 'toml': 'plaintext',
      'sql': 'sql', 'xml': 'xml', 'dart': 'dart',
    };
    return map[ext || ''] || 'plaintext';
  };

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Track cursor position
    editor.onDidChangeCursorPosition((e) => {
      onCursorChange?.(e.position.lineNumber, e.position.column);
    });

    // Ctrl+S / Cmd+S
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      // Trigger save via a custom event (App.tsx listens)
      window.dispatchEvent(new CustomEvent('editor-save'));
    });

    // Custom dark theme matching our TUI
    monaco.editor.defineTheme('dsme-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '', foreground: '00ff00', background: '000000' },
        { token: 'comment', foreground: '006600', fontStyle: 'italic' },
        { token: 'keyword', foreground: '00ccff' },
        { token: 'string', foreground: 'ffaa00' },
        { token: 'number', foreground: 'ff6600' },
        { token: 'type', foreground: '00ffaa' },
        { token: 'function', foreground: 'ffff00' },
        { token: 'variable', foreground: '00ff00' },
        { token: 'operator', foreground: 'ffffff' },
      ],
      colors: {
        'editor.background': '#000000',
        'editor.foreground': '#00ff00',
        'editor.lineHighlightBackground': '#0a1a0a',
        'editor.selectionBackground': '#003300',
        'editorCursor.foreground': '#00ff00',
        'editorLineNumber.foreground': '#004400',
        'editorLineNumber.activeForeground': '#00ff00',
        'editorIndentGuide.background1': '#111111',
        'editor.selectionHighlightBackground': '#002200',
        'editorGutter.background': '#000000',
      }
    });
    monaco.editor.setTheme('dsme-dark');
  };

  return (
    <div className="editor-container" style={{ flex: 1, position: 'relative' }}>
      <Editor
        height="100%"
        language={getLanguage(filename)}
        theme="dsme-dark"
        value={content || "// NO FILE SELECTED\n// USE [ EXPLORER ] OR Ctrl+P TO OPEN A FILE"}
        onChange={onChange}
        onMount={handleEditorMount}
        options={{
          minimap: { enabled: true, maxColumn: 60 },
          fontSize: 14,
          fontFamily: "'JetBrains Mono', monospace",
          fontLigatures: true,
          padding: { top: 16 },
          smoothScrolling: true,
          cursorBlinking: 'phase',
          cursorSmoothCaretAnimation: 'on',
          renderLineHighlight: 'line',
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
          suggest: { showWords: true },
          wordWrap: 'off',
        }}
      />
    </div>
  );
};
