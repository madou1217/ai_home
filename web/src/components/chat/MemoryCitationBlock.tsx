import { memo, useMemo } from 'react';
import { ReadOutlined } from '@ant-design/icons';
import { basenameLike } from './file-reference-utils';
import EventBlock from './EventBlock';
import evt from './EventBlock.module.css';

interface MemoryCitation {
  path: string;
  lines: string;
  note: string;
}

interface Props {
  value: string;
  onOpenFile?: (path: string, options?: { source?: string }) => void;
}

const CITATION_ENTRY_PATTERN = /^(.+):(\d+(?:-\d+)?)\|note=\[(.*)\]$/;

function decodeCitationEntities(value: string) {
  let current = String(value || '');
  for (let index = 0; index < 2; index += 1) {
    const next = current
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === current) break;
    current = next;
  }
  return current;
}

function isOpenCitationEntriesTag(line: string) {
  return /^<citation_entries(?:\s+[^>]*)?>$/i.test(line.trim());
}

function isCloseCitationEntriesTag(line: string) {
  return /^<\/citation_entries>$/i.test(line.trim());
}

function pushCitationLine(citations: MemoryCitation[], line: string) {
  const match = line.trim().match(CITATION_ENTRY_PATTERN);
  if (!match) return;
  citations.push({ path: match[1].trim(), lines: match[2], note: match[3].trim() });
}

// 解析 Codex 记忆引用协议，只消费 citation_entries，忽略 rollout_ids 等非展示字段。
function parseMemoryCitations(value: string): MemoryCitation[] {
  const citations: MemoryCitation[] = [];
  const lines = decodeCitationEntities(value).split('\n');
  let inEntries = false;
  let sawEntriesSection = false;

  for (const line of lines) {
    if (isOpenCitationEntriesTag(line)) {
      inEntries = true;
      sawEntriesSection = true;
      continue;
    }
    if (isCloseCitationEntriesTag(line)) {
      inEntries = false;
      continue;
    }
    if (!inEntries || !line.trim()) continue;
    pushCitationLine(citations, line);
  }

  if (citations.length > 0 || sawEntriesSection) return citations;

  for (const line of lines) {
    pushCitationLine(citations, line);
  }

  return citations;
}

// 后端按 codex-memory source 解析 memories 根目录，相对路径不能提前拼成当前项目路径。
function normalizeMemoryCitationPath(citationPath: string) {
  const text = String(citationPath || '').trim();
  if (!text) return '';
  if (text.startsWith('/') || text.startsWith('~')) return text;

  const parts = text
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .split('/')
    .filter(Boolean);

  if (parts.length < 1 || parts.some((part) => part === '.' || part === '..')) return text;
  return parts.join('/');
}

function MemoryCitationBlock({ value, onOpenFile }: Props) {
  const citations = useMemo(() => parseMemoryCitations(value), [value]);
  const hasParseFallback = citations.length === 0 && String(value || '').trim().length > 0;
  const title = hasParseFallback ? '记忆引用原文' : `${citations.length} 条记忆引用`;

  return (
    <EventBlock tone="memory" icon={<ReadOutlined />} title={title} aria-label="记忆引用">
      <div className={evt.list}>
        {hasParseFallback ? <pre className={evt.raw}>{value}</pre> : null}
        {citations.map((citation, index) => {
          const memoryPath = normalizeMemoryCitationPath(citation.path);
          const fileName = basenameLike(citation.path);

          return (
            <div key={`${citation.path}:${citation.lines}:${index}`}>
              <button
                type="button"
                className={evt.linkRow}
                disabled={!onOpenFile}
                onClick={() => {
                  if (onOpenFile) onOpenFile(memoryPath, { source: 'codex-memory' });
                }}
              >
                <span>{fileName}</span>
                <span className={evt.linkRowLines}>第 {citation.lines} 行</span>
              </button>
              <div className={evt.note}>{citation.note}</div>
            </div>
          );
        })}
      </div>
    </EventBlock>
  );
}

export default memo(MemoryCitationBlock);
