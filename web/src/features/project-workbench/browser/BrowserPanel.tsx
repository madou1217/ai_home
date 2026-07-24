import { useState } from 'react';
import { ArrowLeftOutlined, ArrowRightOutlined, ReloadOutlined, ExportOutlined, MobileOutlined, DesktopOutlined } from '@ant-design/icons';
import { Input, Segmented, Alert } from 'antd';
import Button from '@/components/ui/AppButton';
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
      {error ? <Alert type="error" showIcon message={error} className={styles.browserAlert} /> : null}
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
