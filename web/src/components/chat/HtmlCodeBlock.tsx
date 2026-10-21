import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CameraOutlined,
  CodeOutlined,
  DownOutlined,
  DesktopOutlined,
  EyeOutlined,
  MobileOutlined,
  SettingOutlined,
  StopOutlined,
  VideoCameraOutlined
} from '@ant-design/icons';
import { Dropdown, message } from 'antd';
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
  captureProgressText,
  listRecordableAnimationFormats,
  resolveDefaultRecordFormat,
  usePreviewCaptureActions
} from './capture-bridge';
import { normalizeHtmlPreviewDocument } from './file-preview-utils';
import { openHtmlPreviewWindow } from './html-preview-window';
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

  useEffect(
    () => subscribeCapturePreferences((preferences) => setRecordingSettings(preferences.recording)),
    []
  );

  /** 可选录制格式（菜单项）。 */
  const recordOptions = useMemo(() => listRecordableAnimationFormats(), []);

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
        void capture.runFormat(key as AnimationCaptureFormatId);
      }
    }),
    [capture, recordOptions, recordingSettings]
  );

  /** 主按钮直接执行的格式：全局默认格式（若在可选清单里），否则第一个可选格式。 */
  const recordAction = useMemo(() => resolveDefaultRecordFormat(recordOptions), [recordOptions]);
  const recordingNow = capture.state.kind === 'animation' && !capture.state.stopping;

  const handleCopy = () => {
    if (copied) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleOpenWindow = (device: 'desktop' | 'mobile') => {
    openHtmlPreviewWindow(previewDoc, {
      device,
      title: 'HTML 页面预览',
      captureIdentity: captureIdentity ?? undefined
    });
  };

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
                  className={`${styles.htmlBlockActionBtn} ${recordingNow ? styles.htmlBlockActionBtnRecording : ''}`}
                  aria-label={recordingNow ? '停止录制' : '开始录制'}
                  title={recordingNow ? '停止录制并保存已抓到的帧' : '按当前录制设置开始录制'}
                  disabled={!recordingNow && (capture.state.busy || !recordAction)}
                  onClick={() => {
                    if (recordingNow) {
                      capture.stop();
                      return;
                    }
                    if (recordAction) void capture.runFormat(recordAction);
                  }}
                >
                  {recordingNow ? (
                    <>
                      <StopOutlined /> 停止录制 · {(capture.state.elapsedMs / 1000).toFixed(1)}s
                    </>
                  ) : capture.state.busy ? (
                    captureProgressText(capture.state)
                  ) : (
                    <>
                      <VideoCameraOutlined /> 录制
                    </>
                  )}
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
      <RecordingSettingsModal
        open={recordingSettingsOpen}
        onClose={() => setRecordingSettingsOpen(false)}
        onSaved={setRecordingSettings}
      />
    </div>
  );
}
