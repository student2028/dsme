import React, { useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { useTheme } from '../ThemeContext';

interface Props {
  content: string;
  onChange: (value: string | undefined) => void;
  filename: string;
  onCursorChange?: (line: number, column: number) => void;
}

export const EditorPanel: React.FC<Props> = ({ content, onChange, filename, onCursorChange }) => {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const { theme } = useTheme();

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

  // Sync Monaco theme with app theme
  useEffect(() => {
    if (monacoRef.current) {
      monacoRef.current.editor.setTheme(theme === 'light' ? 'dsme-light' : 'dsme-dark');
    }
  }, [theme]);

  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Track cursor position
    editor.onDidChangeCursorPosition((e: any) => {
      onCursorChange?.(e.position.lineNumber, e.position.column);
    });

    // Ctrl+S / Cmd+S
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      // Trigger save via a custom event (App.tsx listens)
      window.dispatchEvent(new CustomEvent('editor-save'));
    });

    // Dark theme
    monaco.editor.defineTheme('dsme-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c586c0' },
        { token: 'string', foreground: 'ce9178' },
        { token: 'number', foreground: 'b5cea8' },
        { token: 'type', foreground: '4ec9b0' },
        { token: 'function', foreground: 'dcdcaa' },
        { token: 'variable', foreground: '9cdcfe' },
        { token: 'operator', foreground: 'd4d4d4' },
      ],
      colors: {
        'editor.background': '#0d1117',
        'editor.foreground': '#c9d1d9',
        'editor.lineHighlightBackground': '#161b22',
        'editor.selectionBackground': '#264f78',
        'editorCursor.foreground': '#7c6ef0',
        'editorLineNumber.foreground': '#484f58',
        'editorLineNumber.activeForeground': '#c9d1d9',
        'editorIndentGuide.background1': '#21262d',
        'editor.selectionHighlightBackground': '#1a3050',
        'editorGutter.background': '#0d1117',
        'editorWidget.background': '#161b22',
        'editorWidget.border': '#30363d',
      }
    });

    // Light theme
    monaco.editor.defineTheme('dsme-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'd73a49' },
        { token: 'string', foreground: '032f62' },
        { token: 'number', foreground: '005cc5' },
        { token: 'type', foreground: '6f42c1' },
        { token: 'function', foreground: '6f42c1' },
        { token: 'variable', foreground: '24292e' },
        { token: 'operator', foreground: '24292e' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#24292e',
        'editor.lineHighlightBackground': '#f6f8fa',
        'editor.selectionBackground': '#c8d3f5',
        'editorCursor.foreground': '#6c5ce7',
        'editorLineNumber.foreground': '#bfc8d2',
        'editorLineNumber.activeForeground': '#24292e',
        'editorIndentGuide.background1': '#eaecef',
        'editor.selectionHighlightBackground': '#dde6f5',
        'editorGutter.background': '#ffffff',
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#e1e4e8',
      }
    });

    // Apply theme based on current app theme
    monaco.editor.setTheme(theme === 'light' ? 'dsme-light' : 'dsme-dark');
  };

  return (
    <div className="editor-container" style={{ flex: 1, position: 'relative' }}>
      <Editor
        height="100%"
        language={getLanguage(filename)}
        theme={theme === 'light' ? 'dsme-light' : 'dsme-dark'}
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
