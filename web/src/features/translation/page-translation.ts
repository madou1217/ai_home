import type { TranslationStreamEvent } from '@/types';

export interface TranslationPageSegment {
  id: string;
  index: number;
  node: Text;
  source: string;
}

export interface TranslationPageProgress {
  completed: number;
  total: number;
  segment: TranslationPageSegment;
  text: string;
  error?: string;
}

export type PageTranslationMode = 'side-by-side' | 'replace';

export interface PageTranslationSnapshot {
  url: string;
  title: string;
  segments: TranslationPageSegment[];
}

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CANVAS', 'PRE', 'CODE', 'TEXTAREA', 'INPUT']);

function visibleTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || IGNORED_TAGS.has(parent.tagName) || parent.closest('[data-aih-translation]')) return false;
  const value = node.nodeValue?.replace(/\s+/g, ' ').trim() || '';
  if (value.length < 2) return false;
  const style = window.getComputedStyle(parent);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

export function collectPageSegments(root: ParentNode = document): TranslationPageSegment[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: TranslationPageSegment[] = [];
  let current: Node | null;
  let index = 0;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    if (!visibleTextNode(node)) continue;
    const source = node.nodeValue?.replace(/\s+/g, ' ').trim() || '';
    segments.push({ id: `page-segment-${index}`, index, node, source });
    index += 1;
  }
  return segments;
}

/** 外部网站由浏览器工作区调用；只读取正文文本，不把 DOM 或脚本交给翻译服务。 */
export function collectExternalPageSegments(root: Document = document): TranslationPageSegment[] {
  const main = root.querySelector('main, article, [role="main"]') || root.body;
  return collectPageSegments(main || root);
}

export function createBoundedPageTranslator(options: {
  concurrency?: number;
  translate: (text: string, signal: AbortSignal) => Promise<string>;
}) {
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency || 3)));
  return async function translateSegments(
    segments: TranslationPageSegment[],
    signal: AbortSignal,
    onProgress: (progress: TranslationPageProgress) => void,
  ): Promise<TranslationPageProgress[]> {
    const results: TranslationPageProgress[] = [];
    let cursor = 0;
    let completed = 0;
    async function worker() {
      while (!signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= segments.length) return;
        const segment = segments[index];
        try {
          const text = await options.translate(segment.source, signal);
          const progress = { completed: ++completed, total: segments.length, segment, text };
          results[index] = progress;
          onProgress(progress);
        } catch (error) {
          if (signal.aborted) return;
          const progress = { completed: ++completed, total: segments.length, segment, text: '', error: error instanceof Error ? error.message : String(error) };
          results[index] = progress;
          onProgress(progress);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()));
    return results.filter(Boolean);
  };
}

export function applyPageTranslation(progress: TranslationPageProgress[], mode: PageTranslationMode): () => void {
  const snapshots = progress.filter((item) => item.text.trim()).map((item) => ({ item, parent: item.segment.node.parentNode, next: item.segment.node.nextSibling, original: item.segment.node.nodeValue || '' }));
  const markers: HTMLElement[] = [];
  for (const snapshot of snapshots) {
    const { item, parent, next, original } = snapshot;
    if (!parent) continue;
    if (mode === 'replace') {
      item.segment.node.nodeValue = item.text;
      continue;
    }
    const marker = document.createElement('span');
    marker.dataset.aihTranslation = 'side-by-side';
    marker.textContent = item.text;
    marker.setAttribute('aria-label', '译文');
    marker.style.display = 'block';
    marker.style.opacity = '0';
    marker.style.transition = 'opacity 160ms ease';
    parent.insertBefore(marker, next);
    markers.push(marker);
    requestAnimationFrame(() => { marker.style.opacity = '1'; });
    void original;
  }
  return () => {
    for (const snapshot of snapshots) snapshot.item.segment.node.nodeValue = snapshot.original;
    for (const marker of markers) marker.remove();
  };
}

export function isTranslationStreamEvent(event: TranslationStreamEvent | null): boolean {
  return Boolean(event && ['start', 'delta', 'done', 'error', 'attempt_start', 'attempt_success', 'attempt_failure'].includes(event.type));
}
