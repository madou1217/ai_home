import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import { CodeOutlined, CopyOutlined, ExpandOutlined, NodeIndexOutlined } from '@ant-design/icons';
import { Modal, message } from 'antd';
import { readThemeMode } from '@/services/theme-mode';
import { writeClipboardText } from '@/utils/clipboard';
import CodeBlock from './CodeBlock';
import styles from './message-bubble.module.css';

// ```mermaid 代码块渲染成流程图。mermaid 体积大，只在消息里真的出现图时才按需加载；
// 流式输出期间源码不完整会解析失败，此时保持上一次成功的图，再给源码兜底，不闪错误。
type MermaidApi = typeof import('mermaid')['default'];
let mermaidPromise: Promise<MermaidApi> | null = null;
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
}

// mermaid 的解析错误是多行（位置 + 指针 + 期望 token），只取前两段非空行给用户看。
function summarizeError(error: string): string {
  return error.split('\n').map((line) => line.trim()).filter((line) => line && !/^[-^\s]+$/.test(line))
    .slice(0, 2).join(' ').slice(0, 200);
}

function isDarkTheme(): boolean {
  return readThemeMode() === 'dark' || document.body.classList.contains('dark');
}

async function renderMermaid(code: string, dark: boolean): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    // strict：禁用 click/href 回调与 HTML 标签，模型输出的图不能执行脚本。
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
    themeVariables: {
      lineColor: dark ? '#9aa7b8' : '#5b6675',
      edgeLabelBackground: dark ? '#1f2630' : '#ffffff',
    },
    fontFamily: 'inherit',
    flowchart: { htmlLabels: false, curve: 'basis', useMaxWidth: true },
    sequence: { useMaxWidth: true },
  });
  await mermaid.parse(code);
  renderSeq += 1;
  const { svg } = await mermaid.render(`aih-mermaid-${renderSeq}`, code);
  return svg;
}

function useThemeVersion(): boolean {
  const [dark, setDark] = useState(isDarkTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDarkTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

interface Props {
  readonly code: string;
}

export const MermaidBlock = memo(function MermaidBlock({ code }: Props) {
  const source = code.trim();
  const dark = useThemeVersion();
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const titleId = useId();
  const latest = useRef(0);

  useEffect(() => {
    if (!source) return undefined;
    const ticket = ++latest.current;
    // 流式期间源码逐字增长，稍等再渲染，避免每个 token 都重排一次。
    const timer = window.setTimeout(() => {
      renderMermaid(source, dark).then((next) => {
        if (ticket !== latest.current) return;
        setSvg(next);
        setError('');
      }).catch((reason: unknown) => {
        if (ticket !== latest.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [source, dark]);

  const onCopy = useCallback(() => {
    writeClipboardText(source).then(() => message.success('图源码已复制', 1))
      .catch(() => message.error('复制失败，请手动选择'));
  }, [source]);

  // 首次就解析失败（语法错或尚未输出完）：直接按代码块显示，不留空白框。
  if (!svg) {
    return (
      <div className={styles.mermaidPending} data-error={error ? 'true' : undefined}>
        <CodeBlock code={source} language="mermaid" />
        {error
          ? <div className={styles.mermaidStale} role="status">流程图解析失败，已显示源码。{summarizeError(error)}</div>
          : <span className={styles.mermaidPendingHint}>正在生成流程图…</span>}
      </div>
    );
  }

  return (
    <figure className={styles.mermaidBlock} aria-labelledby={titleId}>
      <figcaption className={styles.mermaidHeader}>
        <span id={titleId} className={styles.mermaidTitle}><NodeIndexOutlined aria-hidden /> 流程图</span>
        <span className={styles.mermaidActions}>
          <button type="button" onClick={() => setShowSource((value) => !value)} aria-pressed={showSource}
            aria-label={showSource ? '查看图' : '查看源码'} title={showSource ? '查看图' : '查看源码'}>
            {showSource ? <NodeIndexOutlined /> : <CodeOutlined />}
          </button>
          <button type="button" onClick={onCopy} aria-label="复制图源码" title="复制源码"><CopyOutlined /></button>
          <button type="button" onClick={() => setZoomed(true)} aria-label="放大查看" title="放大查看"><ExpandOutlined /></button>
        </span>
      </figcaption>
      {showSource ? (
        <CodeBlock code={source} language="mermaid" />
      ) : (
        <div className={styles.mermaidCanvas} role="img" aria-label="流程图"
          // svg 由 mermaid 在 securityLevel=strict 下生成（已消毒）。
          dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      {error ? <div className={styles.mermaidStale} role="status">源码有误，显示的是上一次成功的图。{summarizeError(error)}</div> : null}
      <Modal open={zoomed} onCancel={() => setZoomed(false)} footer={null} width="min(1200px, 96vw)" title="流程图" destroyOnClose>
        <div className={`${styles.mermaidCanvas} ${styles.mermaidCanvasZoomed}`} dangerouslySetInnerHTML={{ __html: svg }} />
      </Modal>
    </figure>
  );
});

export default MermaidBlock;
