import { useEffect, useRef, useState } from 'react';
import Editor, { loader, type Monaco, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/gotoError/register';
import 'monaco-editor/features/gotoLine/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/indentation/register';
import 'monaco-editor/features/lineSelection/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/placeholderText/register';
import 'monaco-editor/features/tokenization/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/languages/features/json/register';
import { shikiToMonaco } from '@shikijs/monaco';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import githubLight from '@shikijs/themes/github-light';
import dotenv from '@shikijs/langs/dotenv';
import ini from '@shikijs/langs/ini';
import json from '@shikijs/langs/json';
import jsonc from '@shikijs/langs/jsonc';
import shellscript from '@shikijs/langs/shellscript';
import toml from '@shikijs/langs/toml';
import yaml from '@shikijs/langs/yaml';
import { Spin } from 'antd';
import type { ConfigLanguage } from './config-language';

const EDITOR_THEME = 'github-light';
const REGISTERED_LANGUAGES = [
  { id: 'json', aliases: ['JSON'], extensions: ['.json'] },
  { id: 'jsonc', aliases: ['JSON with Comments'], extensions: ['.jsonc'] },
  { id: 'yaml', aliases: ['YAML'], extensions: ['.yaml', '.yml'] },
  { id: 'toml', aliases: ['TOML'], extensions: ['.toml'] },
  { id: 'dotenv', aliases: ['dotenv'], extensions: ['.env'] },
  { id: 'ini', aliases: ['INI'], extensions: ['.ini', '.properties'] },
  { id: 'shellscript', aliases: ['Shell'], extensions: ['.sh', '.bash', '.zsh'] }
];

let highlighterPromise: Promise<void> | null = null;

loader.config({ monaco });

function registerLanguages(monacoInstance: Monaco) {
  const existing = new Set(monacoInstance.languages.getLanguages().map((language: { id: string }) => language.id));
  for (const language of REGISTERED_LANGUAGES) {
    if (!existing.has(language.id)) monacoInstance.languages.register(language);
  }
}

function initializeSyntaxHighlighting(monacoInstance: Monaco) {
  if (!highlighterPromise) {
    registerLanguages(monacoInstance);
    highlighterPromise = createHighlighterCore({
      themes: [githubLight],
      langs: [json, jsonc, yaml, toml, dotenv, ini, shellscript],
      engine: createOnigurumaEngine(import('shiki/wasm')),
      warnings: false
    }).then((highlighter) => {
      shikiToMonaco(highlighter, monacoInstance);
    });
  }
  return highlighterPromise;
}

interface MonacoConfigEditorProps {
  value: string;
  onChange(value: string): void;
  language: ConfigLanguage;
  virtualPath: string;
  ariaLabel: string;
  height: number;
  onSave?: () => void;
  onHighlightingStatusChange?: (status: 'loading' | 'ready' | 'fallback') => void;
}

export default function MonacoConfigEditor({
  value,
  onChange,
  language,
  virtualPath,
  ariaLabel,
  height,
  onSave,
  onHighlightingStatusChange
}: MonacoConfigEditorProps) {
  const [highlightingStatus, setHighlightingStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const saveRef = useRef(onSave);

  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    let active = true;
    onHighlightingStatusChange?.('loading');
    void initializeSyntaxHighlighting(monaco)
      .then(() => {
        if (!active) return;
        setHighlightingStatus('ready');
        onHighlightingStatusChange?.('ready');
      })
      .catch(() => {
        if (!active) return;
        setHighlightingStatus('fallback');
        onHighlightingStatusChange?.('fallback');
      });
    return () => {
      active = false;
    };
  }, [onHighlightingStatusChange]);

  const handleMount: OnMount = (editor, monacoInstance) => {
    editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
      saveRef.current?.();
    });
  };

  if (highlightingStatus === 'loading') {
    return (
      <div className="toolkit-code-editor-loading" style={{ height }}>
        <Spin tip="正在加载编辑器" />
      </div>
    );
  }

  return (
    <Editor
      height={height}
      path={virtualPath}
      language={language}
      theme={highlightingStatus === 'ready' ? EDITOR_THEME : 'light'}
      value={value}
      onChange={(nextValue) => onChange(nextValue ?? '')}
      onMount={handleMount}
      options={{
        ariaLabel,
        automaticLayout: true,
        bracketPairColorization: { enabled: true },
        folding: true,
        fontFamily: 'var(--font-mono)',
        fontSize: 13,
        glyphMargin: false,
        lineNumbers: 'on',
        minimap: { enabled: false },
        padding: { top: 12, bottom: 12 },
        placeholder: '配置文件为空，可直接输入内容后保存',
        renderValidationDecorations: 'on',
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: 'on'
      }}
    />
  );
}
