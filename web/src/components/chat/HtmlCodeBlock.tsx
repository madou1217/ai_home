import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CameraOutlined,
  CodeOutlined,
  DownOutlined,
  DesktopOutlined,
  EyeOutlined,
  MobileOutlined,
  SettingOutlined,
  VideoCameraOutlined
} from '@ant-design/icons';
import { Dropdown, Modal, Radio, message } from 'antd';
import {
  readCapturePreferences,
  subscribeCapturePreferences,
  summarizeRecordingSettings,
  useCaptureIdentity,
  type AnimationCaptureFormatId,
  type RecordingSettings
} from '../../features/capture';
import { downloadBlobArtifact } from '../../features/capture/frame-utils';
import RecordingSettingsModal from '../../features/capture/RecordingSettingsModal';
import {
  listRecordableAnimationFormats,
  resolveDefaultRecordFormat,
  usePreviewCaptureActions
} from './capture-bridge';
import { normalizeHtmlPreviewDocument } from './file-preview-utils';
import {
  openHtmlPreviewWindow,
  type HtmlPreviewDevice
} from './html-preview-window';
import styles from './message-bubble.module.css';

const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const RECORDING_SETTINGS_KEY = '__recording-settings__';

interface Props {
  code: string;
  language?: string;
}

export default function HtmlCodeBlock({ code }: Props) {
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('preview');
  const [copied, setCopied] = useState(false);

  const previewDoc = useMemo(() => normalizeHtmlPreviewDocument(code), [code]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const captureIdentity = useCaptureIdentity();

  const capture = usePreviewCaptureActions({
    getCaptureTarget: () => stageRef.current,
    getWatermarkIdentity: () => captureIdentity
  });
  const [recordingSettings, setRecordingSettings] = useState<RecordingSettings>(
    () => readCapturePreferences().recording
  );
  const [recordingSettingsOpen, setRecordingSettingsOpen] = useState(false);
  const [recordPromptOpen, setRecordPromptOpen] = useState(false);
  const [recordPromptFormat, setRecordPromptFormat] =
    useState<AnimationCaptureFormatId | null>(null);
  const [recordPreviewDevice, setRecordPreviewDevice] =
    useState<HtmlPreviewDevice>('desktop');

  useEffect(
    () => subscribeCapturePreferences((preferences) => setRecordingSettings(preferences.recording)),
    []
  );

  /** 可选录制格式（菜单项）。 */
  const recordOptions = useMemo(() => listRecordableAnimationFormats(), []);

  const openRecordPrompt = useCallback((format: AnimationCaptureFormatId | null) => {
    setRecordPreviewDevice('desktop');
    setRecordPromptFormat(format);
    setRecordPromptOpen(true);
  }, []);

  const recordMenu = useMemo(
    () => ({
      items: [
        ...recordOptions.map((option) => ({ key: option.id, label: option.label })),
        { type: 'divider' as const },
        {
          key: RECORDING_SETTINGS_KEY,
          icon: <SettingOutlined />,
          label: `录制方式与时长 · ${summarizeRecordingSettings(recordingSettings)}`
        }
      ],
      onClick: ({ key }: { key: string }) => {
        if (key === RECORDING_SETTINGS_KEY) {
          setRecordingSettingsOpen(true);
          return;
        }
        openRecordPrompt(key as AnimationCaptureFormatId);
      }
    }),
    [openRecordPrompt, recordOptions, recordingSettings]
  );

  /** 主按钮直接执行的格式：全局默认格式（若在可选清单里），否则第一个可选格式。 */
  const recordAction = useMemo(() => resolveDefaultRecordFormat(recordOptions), [recordOptions]);
  const pendingRecordFormat = recordPromptFormat ?? recordAction;
  const pendingRecordFormatLabel = useMemo(
    () =>
      recordOptions.find((option) => option.id === pendingRecordFormat)?.label ?? '全局默认格式',
    [pendingRecordFormat, recordOptions]
  );

  const handleCopy = () => {
    if (copied) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleOpenWindow = (device: 'desktop' | 'mobile') => {
    const popup = openHtmlPreviewWindow(previewDoc, {
      device,
      title: 'HTML 页面预览',
      captureIdentity: captureIdentity ?? undefined
    });
    if (!popup) message.error('预览窗口被浏览器拦截，请允许弹窗后重试');
  };

  const confirmRecordPreview = useCallback(() => {
    setRecordPromptOpen(false);
    const popup = openHtmlPreviewWindow(previewDoc, {
      device: recordPreviewDevice,
      title: 'HTML 页面预览',
      captureIdentity: captureIdentity ?? undefined,
      autoCapture: { kind: 'record', format: pendingRecordFormat ?? undefined }
    });
    if (!popup) message.error('预览窗口被浏览器拦截，请允许弹窗后重试');
  }, [
    captureIdentity,
    pendingRecordFormat,
    previewDoc,
    recordPreviewDevice
  ]);

  const [beautifyState, setBeautifyState] = useState({ busy: false, progressLabel: '' });
  const handleBeautifyExport = useCallback(async () => {
    if (beautifyState.busy) return;
    setBeautifyState({ busy: true, progressLabel: '正在生成…' });
    try {
      const { createBeautifiedCapture } = await import('../../features/capture/code-beautify');
      const { blob, fileName } = await createBeautifiedCapture({
        code,
        baseName: 'html-code',
        onProgress: (progressLabel) => setBeautifyState({ busy: true, progressLabel })
      });
      downloadBlobArtifact(blob, fileName, blob.type);
      message.success('美化截图已保存');
    } catch (error) {
      message.error(error instanceof Error ? `美化导出失败：${error.message}` : '美化导出失败');
    } finally {
      setBeautifyState({ busy: false, progressLabel: '' });
    }
  }, [beautifyState.busy, code]);

  return (
    <div className={styles.htmlBlockContainer}>
      <div className={styles.htmlBlockHeader}>
        <div className={styles.htmlBlockTabs}>
          <button
            type="button"
            className={`${styles.htmlBlockTab} ${viewMode === 'preview' ? styles.htmlBlockTabActive : ''}`}
            onClick={() => setViewMode('preview')}
          >
            <EyeOutlined /> 预览
          </button>
          <button
            type="button"
            className={`${styles.htmlBlockTab} ${viewMode === 'code' ? styles.htmlBlockTabActive : ''}`}
            onClick={() => setViewMode('code')}
          >
            <CodeOutlined /> 代码
          </button>
        </div>

        <div className={styles.htmlBlockActions}>
          {viewMode === 'code' && (
            <button
              type="button"
              className={styles.htmlBlockActionBtn}
              title="导出美化代码截图"
              disabled={beautifyState.busy}
              onClick={() => void handleBeautifyExport()}
            >
              {beautifyState.busy ? beautifyState.progressLabel : <><CameraOutlined /> 美化导出</>}
            </button>
          )}
          {viewMode === 'preview' && (
            <>
              <button
                type="button"
                className={styles.htmlBlockActionBtn}
                title="在 PC 窗口中预览"
                onClick={() => handleOpenWindow('desktop')}
              >
                <DesktopOutlined /> PC 弹窗
              </button>
              <button
                type="button"
                className={styles.htmlBlockActionBtn}
                title="在手机窗口中预览"
                onClick={() => handleOpenWindow('mobile')}
              >
                <MobileOutlined /> 手机弹窗
              </button>
              <button
                type="button"
                className={styles.htmlBlockActionBtn}
                title="保存当前预览为截图"
                disabled={capture.state.busy}
                onClick={() => void capture.runFormat('png')}
              >
                <CameraOutlined /> 截图
              </button>
              <span className={styles.htmlBlockSplit}>
                <button
                  type="button"
                  className={styles.htmlBlockActionBtn}
                  aria-label="在独立预览中录制"
                  title="打开独立预览并录制（默认 PC）"
                  disabled={capture.state.busy || !recordAction}
                  onClick={() => openRecordPrompt(recordAction)}
                >
                  <VideoCameraOutlined /> 录制
                </button>
                <Dropdown menu={recordMenu} trigger={['click']} disabled={capture.state.busy}>
                  <button
                    type="button"
                    className={styles.htmlBlockActionBtn}
                    aria-label="选择录制格式"
                    disabled={capture.state.busy}
                  >
                    <DownOutlined />
                  </button>
                </Dropdown>
              </span>
            </>
          )}
          <button
            type="button"
            className={styles.htmlBlockActionBtn}
            onClick={handleCopy}
          >
            {copied ? '已复制' : '复制代码'}
          </button>
        </div>
      </div>

      <div className={styles.htmlBlockBody}>
        {viewMode === 'preview' ? (
          <div className={styles.htmlPreviewStage} ref={stageRef}>
            <iframe
              className={styles.htmlPreviewFrame}
              title="HTML Preview"
              sandbox={HTML_PREVIEW_SANDBOX}
              srcDoc={previewDoc}
            />
          </div>
        ) : (
          <pre className={styles.htmlCodeContent}>
            <code>{code}</code>
          </pre>
        )}
      </div>
      <Modal
        open={recordPromptOpen}
        title="在独立预览中录制"
        okText="打开并录制"
        cancelText="取消"
        onOk={confirmRecordPreview}
        onCancel={() => setRecordPromptOpen(false)}
      >
        <div className={styles.htmlRecordPrompt}>
          <p className={styles.htmlRecordPromptHint}>
            聊天内的预览会随消息区域裁剪和滚动。录制将改在独立预览窗口中进行，画面按完整视口取景。
          </p>
          <Radio.Group
            value={recordPreviewDevice}
            onChange={(event) =>
              setRecordPreviewDevice(event.target.value as HtmlPreviewDevice)
            }
          >
            <Radio.Button value="desktop">
              <DesktopOutlined /> PC 预览（推荐）
            </Radio.Button>
            <Radio.Button value="mobile">
              <MobileOutlined /> 手机预览
            </Radio.Button>
          </Radio.Group>
          <p className={styles.htmlRecordPromptMeta}>录制格式：{pendingRecordFormatLabel}</p>
          <p className={styles.htmlRecordPromptMeta}>
            页面渲染完成后会自动开始。若浏览器要求一次用户手势，预览窗口会高亮「录制」按钮，点击即可开始。
          </p>
        </div>
      </Modal>
      <RecordingSettingsModal
        open={recordingSettingsOpen}
        onClose={() => setRecordingSettingsOpen(false)}
        onSaved={setRecordingSettings}
      />
    </div>
  );
}
