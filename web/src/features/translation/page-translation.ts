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
  // BrowserPanel may pass a Document from an iframe. Always resolve style
  // through that node's realm; the host window cannot reliably inspect nodes
  // owned by another document.
  const view = node.ownerDocument?.defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(parent);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

export function collectPageSegments(root: ParentNode = document): TranslationPageSegment[] {
  const ownerDocument = root.nodeType === 9
    ? root as Document
    : (root as Node).ownerDocument || document;
  const showText = typeof NodeFilter === 'undefined' ? 4 : NodeFilter.SHOW_TEXT;
  const walker = ownerDocument.createTreeWalker(root as Node, showText);
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
  const replaceAnimations = new Map<number, Window | null>();
  const replacementState = new Map<Text, { expected: string; target: string }>();
  let undone = false;

  function schedule(callback: FrameRequestCallback, view: Window | null): number {
    if (view && typeof view.requestAnimationFrame === 'function') return view.requestAnimationFrame(callback);
    return window.setTimeout(() => callback(performance.now()), 16);
  }

  function cancelScheduledFrames() {
    for (const [frame, view] of replaceAnimations) {
      if (view && typeof view.cancelAnimationFrame === 'function') view.cancelAnimationFrame(frame);
      else globalThis.clearTimeout(frame);
    }
    replaceAnimations.clear();
  }

  function animateReplacement(node: Text, original: string, target: string) {
    const characters = Array.from(target);
    const maxFrames = 48;
    const chunkSize = Math.max(1, Math.ceil(characters.length / maxFrames));
    let visibleLength = 0;
    let expected = original;
    replacementState.set(node, { expected, target });
    const view = node.ownerDocument?.defaultView || null;

    const step = () => {
      replaceAnimations.delete(frame);
      if (undone || !node.parentNode || node.nodeValue !== expected) return;
      visibleLength = Math.min(characters.length, visibleLength + chunkSize);
      expected = characters.slice(0, visibleLength).join('');
      node.nodeValue = expected;
      replacementState.set(node, { expected, target });
      if (visibleLength < characters.length) {
        frame = schedule(step, view);
        replaceAnimations.set(frame, view);
      }
    };
    let frame = schedule(step, view);
    replaceAnimations.set(frame, view);
  }

  for (const snapshot of snapshots) {
    const { item, parent, next, original } = snapshot;
    if (!parent) continue;
    if (mode === 'replace') {
      // Do not overwrite a concurrent edit that happened between translation
      // and applying the result. The same expected-value guard is checked on
      // every animation frame and again when undoing.
      if (item.segment.node.nodeValue !== original) continue;
      animateReplacement(item.segment.node, original, item.text);
      continue;
    }
    const ownerDocument = parent.ownerDocument || document;
    const marker = ownerDocument.createElement('span');
    marker.dataset.aihTranslation = 'side-by-side';
    marker.textContent = item.text;
    marker.setAttribute('aria-label', '译文');
    marker.style.display = 'block';
    marker.style.opacity = '0';
    marker.style.transition = 'opacity 160ms ease';
    parent.insertBefore(marker, next);
    markers.push(marker);
    const view = ownerDocument.defaultView;
    if (view && typeof view.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => { marker.style.opacity = '1'; });
    } else {
      marker.style.opacity = '1';
    }
    void original;
  }
  return () => {
    if (undone) return;
    undone = true;
    cancelScheduledFrames();
    for (const snapshot of snapshots) {
      const state = replacementState.get(snapshot.item.segment.node);
      if (state) {
        // Preserve edits made after the translation. Only restore a node that
        // still contains the text written by this transaction.
        if (snapshot.item.segment.node.nodeValue === state.expected) {
          snapshot.item.segment.node.nodeValue = snapshot.original;
        }
      } else if (mode !== 'replace') {
        snapshot.item.segment.node.nodeValue = snapshot.original;
      }
    }
    for (const marker of markers) marker.remove();
  };
}

export function isTranslationStreamEvent(event: TranslationStreamEvent | null): boolean {
  return Boolean(event && ['start', 'delta', 'done', 'error', 'attempt_start', 'attempt_success', 'attempt_failure'].includes(event.type));
}
