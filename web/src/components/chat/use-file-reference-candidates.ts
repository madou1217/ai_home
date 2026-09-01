/**
 * @ 文件引用候选数据：拉取工作区文件树并按 query 过滤。
 * 数据逻辑从 FileReferencePopover 抽离为 hook，使父组件（MessageArea）持有候选列表，
 * 键盘导航（↑↓/Tab/Enter）才能按候选数量准确取模——与 SlashCommandMenu 同一受控模式。
 */
import { useEffect, useMemo, useState } from 'react';
import { fsAPI, type FileTreeEntry } from '@/services/api';

export interface FileReferenceCandidate {
  name: string;
  path: string;
  type: 'file' | 'folder';
  description?: string;
}

const IGNORED_NAMES = new Set(['node_modules', 'dist', '.git']);
const MAX_CANDIDATES = 12;
// 递归拉取的护栏：目录树每层平铺展开，限制深度与总节点数，避免大仓库请求爆炸。
const MAX_TREE_DEPTH = 3;
const MAX_TREE_NODES = 500;

/** 单层目录 entries → 引用候选；隐藏项与构建产物目录直接剔除（也不再递归其子树）。 */
export function fileTreeEntriesToCandidates(
  entries: FileTreeEntry[],
  parentPath = '',
): FileReferenceCandidate[] {
  const list: FileReferenceCandidate[] = [];
  for (const entry of entries) {
    const name = String(entry?.name || '');
    if (!name || name.startsWith('.') || IGNORED_NAMES.has(name)) continue;
    list.push({
      name,
      path: parentPath ? `${parentPath}/${name}` : name,
      type: entry.type === 'directory' ? 'folder' : 'file',
    });
  }
  return list;
}

/** 按 name/path 子串过滤候选（大小写不敏感），限制返回数量。 */
export function filterFileReferenceCandidates(
  candidates: FileReferenceCandidate[],
  query: string,
  limit = MAX_CANDIDATES,
): FileReferenceCandidate[] {
  if (!query) return candidates.slice(0, limit);
  const q = query.toLowerCase();
  return candidates
    .filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
    .slice(0, limit);
}

/** 递归拉取项目文件树（深度/节点数有上限）； cancelled 后静默丢弃结果。 */
async function fetchFileReferenceTree(
  projectPath: string,
  isCancelled: () => boolean,
): Promise<FileReferenceCandidate[]> {
  const acc: FileReferenceCandidate[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (isCancelled() || acc.length >= MAX_TREE_NODES) return;
    const res = await fsAPI.tree(projectPath, dir);
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    const candidates = fileTreeEntriesToCandidates(entries, dir);
    acc.push(...candidates);
    if (depth >= MAX_TREE_DEPTH) return;
    const subdirs = candidates.filter((c) => c.type === 'folder');
    await Promise.all(subdirs.map((sub) => walk(sub.path, depth + 1)));
  };
  await walk('', 0);
  return acc;
}

export interface FileReferenceCandidatesState {
  candidates: FileReferenceCandidate[];
  loading: boolean;
  fetchError: string | null;
}

export function useFileReferenceCandidates(
  projectPath: string | undefined,
  query: string,
  active: boolean,
): FileReferenceCandidatesState {
  const [remote, setRemote] = useState<FileReferenceCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !projectPath) {
      setRemote([]);
      setFetchError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetchFileReferenceTree(projectPath, () => cancelled)
      .then((tree) => {
        if (!cancelled) setRemote(tree);
      })
      .catch((err: any) => {
        if (!cancelled) setFetchError(err?.message || '加载项目文件树失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectPath, active]);

  const candidates = useMemo(
    () => filterFileReferenceCandidates(remote, query),
    [remote, query],
  );
  return { candidates, loading, fetchError };
}
