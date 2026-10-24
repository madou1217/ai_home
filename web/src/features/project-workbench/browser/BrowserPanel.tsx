import { useRef, useState } from 'react';
import { ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, ExportOutlined, MobileOutlined, DesktopOutlined, TranslationOutlined } from '@ant-design/icons';
import { Input, Segmented, message } from 'antd';
import Button from '@/components/ui/AppButton';
import { translationAPI } from '@/services/api';
import { collectExternalPageSegments, applyPageTranslation, createBoundedPageTranslator, type TranslationPageProgress } from '@/features/translation/page-translation';
import { normalizeBrowserUrl } from './browser-url-policy';
import styles from '../project-workbench.module.css';

interface Props {
  initialUrl?: string;
  onUrlChange?: (url: string) => void;
}

export default function BrowserPanel({ initialUrl = 'http://127.0.0.1:9527', onUrlChange }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [draft, setDraft] = useState(initialUrl);
  const [error, setError] = useState('');
  const [mobile, setMobile] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [translating, setTranslating] = useState(false);
  const [translated, setTranslated] = useState(false);
  const undoRef = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const navigate = () => {
    const result = normalizeBrowserUrl(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError('');
    setUrl(result.url);
    setDraft(result.url);
    onUrlChange?.(result.url);
  };

  const translatePage = async () => {
    if (translating) return;
    const frame = document.querySelector<HTMLIFrameElement>('[title="开发预览"]');
    let doc: Document | null = null;
    try { doc = frame?.contentDocument || null; } catch (_error) { doc = null; }
    if (!doc) {
      message.warning('该网站禁止嵌入式读取，请点击右侧打开按钮后使用系统取词或 AIH 翻译页面');
      return;
    }
    const segments = collectExternalPageSegments(doc);
    if (!segments.length) { message.info('当前网页没有可翻译正文'); return; }
    setTranslating(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const translator = createBoundedPageTranslator({
      concurrency: 3,
      translate: async (text, signal) => {
        let output = '';
        await translationAPI.stream({ text, source: 'auto', target: 'zh-Hans', targetPolicy: 'saved', operation: 'page' }, { signal, onEvent: (event) => {
          if (event.type === 'delta') output += event.content;
          if (event.type === 'error') throw new Error(event.message || '翻译失败');
        }});
        return output;
      }
    });
    try {
      const progress = await translator(segments, controller.signal, (_item: TranslationPageProgress) => {});
      undoRef.current = applyPageTranslation(progress, 'side-by-side');
      setTranslated(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '整页翻译失败');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setTranslating(false);
    }
  };

  return (
    <section className={styles.browserPanel}>
      <div className={styles.browserToolbar}>
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} disabled />
        <Button type="text" size="small" icon={<ArrowRightOutlined />} disabled />
        <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => setFrameKey((k) => k + 1)} />
        <Input
          value={draft}
          size="small"
          className={styles.browserAddress}
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={navigate}
          aria-label="预览地址"
        />
        <Button size="small" onClick={navigate}>打开</Button>
        {translating ? <Button size="small" icon={<TranslationOutlined />} onClick={() => abortRef.current?.abort()}>停止翻译</Button> : <Button size="small" icon={<TranslationOutlined />} onClick={() => void translatePage()}>翻译整页</Button>}
        {translated ? <Button size="small" onClick={() => { undoRef.current?.(); undoRef.current = null; setTranslated(false); }}>撤回</Button> : null}
        <Segmented
          size="small"
          value={mobile ? 'mobile' : 'desktop'}
          onChange={(value) => setMobile(value === 'mobile')}
          options={[
            { value: 'desktop', icon: <DesktopOutlined />, label: '桌面' },
            { value: 'mobile', icon: <MobileOutlined />, label: '手机' },
          ]}
        />
        <Button type="text" size="small" icon={<ExportOutlined />} onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} />
      </div>
      {error ? <div className={styles.browserInlineError} role="status">{error}</div> : null}
      <div className={styles.browserStage}>
        <iframe
          key={`${url}-${frameKey}`}
          src={url}
          title="开发预览"
          className={`${styles.browserFrame} ${mobile ? styles.browserFrameMobile : ''}`}
          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          referrerPolicy="no-referrer"
        />
      </div>
    </section>
  );
}
