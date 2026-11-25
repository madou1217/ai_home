import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Tooltip
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileTextOutlined,
  FolderOutlined,
  LinkOutlined,
  PictureOutlined,
  PushpinFilled,
  PushpinOutlined,
  SearchOutlined,
  SnippetsOutlined,
  StarFilled,
  SyncOutlined
} from '@ant-design/icons';
import {
  clipboardAPI,
  extractClipboardErrorMessage,
  type ClipboardItem as ClipboardEntry,
  type ClipboardItemDetail,
  type ClipboardKind,
  type ClipboardServerProfile,
  type ClipboardSettings,
  type ClipboardSettingsPatch,
  type ClipboardStatus
} from './clipboard-api';
import styles from './clipboard.module.css';

type KindFilter = 'all' | ClipboardKind;

interface InlineFeedback {
  tone: 'secondary' | 'danger';
  text: string;
}

const KIND_OPTIONS: Array<{ label: string; value: KindFilter }> = [
  { label: '全部', value: 'all' },
  { label: '文本', value: 'text' },
  { label: '链接', value: 'link' },
  { label: '图片', value: 'image' },
  { label: '文件', value: 'file' }
];

const KIND_LABELS: Record<ClipboardKind, string> = {
  text: '文本',
  link: '链接',
  image: '图片',
  file: '文件'
};

function renderKindIcon(kind: ClipboardKind) {
  switch (kind) {
    case 'link':
      return <LinkOutlined className={styles.kindIcon} />;
    case 'image':
      return <PictureOutlined className={styles.kindIcon} />;
    case 'file':
      return <FolderOutlined className={styles.kindIcon} />;
    case 'text':
    default:
      return <FileTextOutlined className={styles.kindIcon} />;
  }
}

function formatRelativeTimeZh(tsMs: number, nowMs: number): string {
  if (!tsMs || tsMs <= 0) return '-';
  const diffMs = Math.max(0, nowMs - tsMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  if (diffMs < minuteMs) return '刚刚';
  if (diffMs < hourMs) return `${Math.floor(diffMs / minuteMs)} 分钟前`;

  const date = new Date(tsMs);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * hourMs;

  if (tsMs >= startOfToday) {
    return `${Math.floor(diffMs / hourMs)} 小时前`;
  }
  if (tsMs >= startOfYesterday) {
    return '昨天';
  }
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  if (date.getFullYear() === now.getFullYear()) {
    return `${mm}-${dd}`;
  }
  return `${date.getFullYear()}-${mm}-${dd}`;
}

function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function isSafeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\s\r\n]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

function extensionForMime(mime: string): string {
  const clean = mime.split(';')[0].trim().toLowerCase();
  if (clean === 'image/jpeg') return 'jpg';
  if (clean === 'image/webp') return 'webp';
  if (clean === 'image/gif') return 'gif';
  return 'png';
}

async function blobToPngBlob(source: Blob): Promise<Blob> {
  const url = URL.createObjectURL(source);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片解码失败'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持画布转换');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => {
        if (out) resolve(out);
        else reject(new Error('PNG 转换失败'));
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ClipboardWorkspace() {
  const [status, setStatus] = useState<ClipboardStatus | null>(null);
  const [settings, setSettings] = useState<ClipboardSettings | null>(null);
  const [servers, setServers] = useState<ClipboardServerProfile[]>([]);
  const [items, setItems] = useState<ClipboardEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [detail, setDetail] = useState<ClipboardItemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const [loading, setLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [acting, setActing] = useState(false);
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);

  const [originalModalOpen, setOriginalModalOpen] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [fallbackDownloadUrl, setFallbackDownloadUrl] = useState<string | null>(null);
  const [fallbackDownloadName, setFallbackDownloadName] = useState<string>('clipboard-image.png');

  const originalUrlRef = useRef<string | null>(null);
  const fallbackUrlRef = useRef<string | null>(null);

  const replaceOriginalUrl = useCallback((next: string | null) => {
    if (originalUrlRef.current) {
      URL.revokeObjectURL(originalUrlRef.current);
    }
    originalUrlRef.current = next;
    setOriginalUrl(next);
  }, []);

  const replaceFallbackDownloadUrl = useCallback((next: string | null) => {
    if (fallbackUrlRef.current) {
      URL.revokeObjectURL(fallbackUrlRef.current);
    }
    fallbackUrlRef.current = next;
    setFallbackDownloadUrl(next);
  }, []);

  useEffect(() => {
    return () => {
      if (originalUrlRef.current) {
        URL.revokeObjectURL(originalUrlRef.current);
      }
      if (fallbackUrlRef.current) {
        URL.revokeObjectURL(fallbackUrlRef.current);
      }
    };
  }, []);

  // 250ms client-side debounce over loaded 100 items.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchInput.trim().toLowerCase());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadAll = useCallback(async (clearFeedback = false) => {
    setLoading(true);
    if (clearFeedback) {
      setFeedback(null);
    }
    try {
      const [nextStatus, nextSettings, nextServers, nextItems] = await Promise.all([
        clipboardAPI.getStatus(),
        clipboardAPI.getSettings(),
        clipboardAPI.listServers(),
        clipboardAPI.listItems({ limit: 100 })
      ]);
      setStatus(nextStatus);
      setSettings(nextSettings);
      setServers(nextServers);
      setItems(nextItems);
      setSelectedId((prev) => {
        if (prev && nextItems.some((it) => it.id === prev)) {
          return prev;
        }
        return nextItems[0]?.id ?? '';
      });
    } catch (error) {
      setFeedback({
        tone: 'danger',
        text: extractClipboardErrorMessage(error, '加载剪贴板数据失败')
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshItemsAndStatus = useCallback(async () => {
    try {
      const [nextItems, nextStatus] = await Promise.all([
        clipboardAPI.listItems({ limit: 100 }),
        clipboardAPI.getStatus()
      ]);
      setItems(nextItems);
      setStatus(nextStatus);
      setSelectedId((prev) => {
        if (prev && nextItems.some((it) => it.id === prev)) {
          return prev;
        }
        return nextItems[0]?.id ?? '';
      });
    } catch (error) {
      setFeedback({
        tone: 'danger',
        text: extractClipboardErrorMessage(error, '刷新列表失败')
      });
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (kindFilter !== 'all' && item.kind !== kindFilter) {
        return false;
      }
      if (!debouncedQuery) {
        return true;
      }
      if (item.preview.toLowerCase().includes(debouncedQuery)) return true;
      if (item.id.toLowerCase().includes(debouncedQuery)) return true;
      if (item.sourceApp && item.sourceApp.toLowerCase().includes(debouncedQuery)) return true;
      if (Array.isArray(item.files)) {
        return item.files.some((f) => f.toLowerCase().includes(debouncedQuery));
      }
      return false;
    });
  }, [items, kindFilter, debouncedQuery]);

  const selectedItem = useMemo(() => {
    if (!filteredItems.length) return null;
    return filteredItems.find((it) => it.id === selectedId) ?? filteredItems[0];
  }, [filteredItems, selectedId]);

  const activeItemId = selectedItem?.id ?? '';

  // Load detail for text/link items when selection changes; clear previous download fallback.
  useEffect(() => {
    replaceFallbackDownloadUrl(null);
    if (!activeItemId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    clipboardAPI
      .getItem(activeItemId)
      .then((loaded) => {
        if (!cancelled) {
          setDetail(loaded);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDetail(null);
          setFeedback({
            tone: 'danger',
            text: extractClipboardErrorMessage(error, '加载条目详情失败')
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeItemId, replaceFallbackDownloadUrl]);

  const applySettingsPatch = useCallback(async (patch: ClipboardSettingsPatch, successText: string) => {
    setSavingSettings(true);
    setFeedback(null);
    try {
      const updated = await clipboardAPI.patchSettings(patch);
      setSettings(updated);
      const nextStatus = await clipboardAPI.getStatus();
      setStatus(nextStatus);
      setFeedback({ tone: 'secondary', text: successText });
    } catch (error) {
      setFeedback({
        tone: 'danger',
        text: extractClipboardErrorMessage(error, '保存设置失败')
      });
    } finally {
      setSavingSettings(false);
    }
  }, []);

  const handleTriggerSync = useCallback(async () => {
    setSyncing(true);
    setFeedback(null);
    try {
      await clipboardAPI.triggerSync();
      await refreshItemsAndStatus();
      setFeedback({ tone: 'secondary', text: '同步完成' });
    } catch (error) {
      setFeedback({
        tone: 'danger',
        text: extractClipboardErrorMessage(error, '手动同步失败')
      });
      try {
        setStatus(await clipboardAPI.getStatus());
      } catch {
        // Keep primary sync error visible.
      }
    } finally {
      setSyncing(false);
    }
  }, [refreshItemsAndStatus]);

  const handleCopyText = useCallback(async (text: string, label = '已复制到剪贴板') => {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      setFeedback({ tone: 'danger', text: '当前浏览器环境不支持写入剪贴板（需要 HTTPS 或 localhost）' });
      return false;
    }
    await navigator.clipboard.writeText(text);
    setFeedback({ tone: 'secondary', text: label });
    return true;
  }, []);

  const handleDownloadImage = useCallback(async (item: ClipboardEntry) => {
    try {
      const { blob, contentType } = await clipboardAPI.getItemContentBlob(item.id);
      const url = URL.createObjectURL(blob);
      const ext = extensionForMime(contentType || item.mime);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clipboard-${item.id.slice(0, 8)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setFeedback({ tone: 'secondary', text: '已开始下载原图' });
    } catch (error) {
      setFeedback({
        tone: 'danger',
        text: extractClipboardErrorMessage(error, '下载原图失败')
      });
    }
  }, []);

  const handleCopyItem = useCallback(
    async (item: ClipboardEntry) => {
      setActing(true);
      setFeedback(null);
      try {
        if (item.kind === 'image') {
          const { blob, contentType } = await clipboardAPI.getItemContentBlob(item.id);
          const mime = contentType || item.mime || 'image/png';
          let copied = false;
          const NativeClipboardItem =
            typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined;
          if (
            NativeClipboardItem &&
            navigator.clipboard &&
            typeof navigator.clipboard.write === 'function'
          ) {
            try {
              await navigator.clipboard.write([new NativeClipboardItem({ [mime]: blob })]);
              copied = true;
            } catch {
              // Many browsers only accept image/png in ClipboardItem; try converting via canvas.
              if (mime !== 'image/png') {
                try {
                  const pngBlob = await blobToPngBlob(blob);
                  await navigator.clipboard.write([new NativeClipboardItem({ 'image/png': pngBlob })]);
                  copied = true;
                } catch {
                  copied = false;
                }
              }
            }
          }
          if (copied) {
            replaceFallbackDownloadUrl(null);
            setFeedback({ tone: 'secondary', text: '图片已复制到剪贴板' });
            await refreshItemsAndStatus();
          } else {
            const url = URL.createObjectURL(blob);
            setFallbackDownloadName(`clipboard-${item.id.slice(0, 8)}.${extensionForMime(mime)}`);
            replaceFallbackDownloadUrl(url);
            setFeedback({
              tone: 'secondary',
              text: '浏览器不支持直接复制此图片，请使用下方「下载原图」链接'
            });
          }
          return;
        }

        if (item.kind === 'file') {
          const joined = (item.files ?? []).join('\n');
          if (!joined) {
            setFeedback({ tone: 'danger', text: '文件路径为空' });
            return;
          }
          const ok = await handleCopyText(joined, '文件路径已复制');
          if (ok) {
            await refreshItemsAndStatus();
          }
          return;
        }

        // Text or link: fetch full exact bytes via /items/{id}/content.
        const fullText = await clipboardAPI.getItemContentText(item.id);
        const ok = await handleCopyText(fullText, '已复制到剪贴板');
        if (ok) {
          await refreshItemsAndStatus();
        }
      } catch (error) {
        setFeedback({
          tone: 'danger',
          text: extractClipboardErrorMessage(error, '复制失败')
        });
      } finally {
        setActing(false);
      }
    },
    [handleCopyText, refreshItemsAndStatus, replaceFallbackDownloadUrl]
  );

  const handleCopySinglePath = useCallback(
    async (filePath: string) => {
      setActing(true);
      setFeedback(null);
      try {
        const ok = await handleCopyText(filePath, '路径已复制');
        if (ok) {
          await refreshItemsAndStatus();
        }
      } catch (error) {
        setFeedback({
          tone: 'danger',
          text: extractClipboardErrorMessage(error, '复制路径失败')
        });
      } finally {
        setActing(false);
      }
    },
    [handleCopyText, refreshItemsAndStatus]
  );

  const handleTogglePin = useCallback(
    async (item: ClipboardEntry) => {
      setActing(true);
      setFeedback(null);
      try {
        const updated = await clipboardAPI.pinItem(item.id, !item.pinned);
        setFeedback({
          tone: 'secondary',
          text: updated.pinned ? '已置顶' : '已取消置顶'
        });
        await refreshItemsAndStatus();
      } catch (error) {
        setFeedback({
          tone: 'danger',
          text: extractClipboardErrorMessage(error, '更新置顶状态失败')
        });
      } finally {
        setActing(false);
      }
    },
    [refreshItemsAndStatus]
  );

  const handleDelete = useCallback(
    async (item: ClipboardEntry) => {
      setActing(true);
      setFeedback(null);
      try {
        await clipboardAPI.deleteItem(item.id);
        setFeedback({ tone: 'secondary', text: '已删除条目' });
        await refreshItemsAndStatus();
      } catch (error) {
        setFeedback({
          tone: 'danger',
          text: extractClipboardErrorMessage(error, '删除条目失败')
        });
      } finally {
        setActing(false);
      }
    },
    [refreshItemsAndStatus]
  );

  const handleOpenOriginalImage = useCallback(
    async (item: ClipboardEntry) => {
      setOriginalModalOpen(true);
      setOriginalLoading(true);
      replaceOriginalUrl(null);
      try {
        const { blob } = await clipboardAPI.getItemContentBlob(item.id);
        replaceOriginalUrl(URL.createObjectURL(blob));
      } catch (error) {
        setOriginalModalOpen(false);
        setFeedback({
          tone: 'danger',
          text: extractClipboardErrorMessage(error, '加载原图失败')
        });
      } finally {
        setOriginalLoading(false);
      }
    },
    [replaceOriginalUrl]
  );

  const handleCloseOriginalModal = useCallback(() => {
    setOriginalModalOpen(false);
    replaceOriginalUrl(null);
  }, [replaceOriginalUrl]);

  const serverOptions = useMemo(() => {
    const opts: Array<{ label: string; value: string }> = [{ label: '不同步', value: '' }];
    for (const s of servers) {
      opts.push({
        label: s.label && s.label !== s.endpoint ? `${s.label} (${s.endpoint})` : s.endpoint,
        value: s.id
      });
    }
    const currentTarget = settings?.syncTargetProfileId ?? '';
    if (currentTarget && !servers.some((s) => s.id === currentTarget)) {
      opts.push({ label: currentTarget, value: currentTarget });
    }
    return opts;
  }, [servers, settings?.syncTargetProfileId]);

  const captureUnsupported = status !== null && !status.capture.supported;
  const devices = status?.devices ?? [];
  const deviceTooltip =
    devices.length > 0
      ? devices.map((d) => `${d.name} (${d.platform})`).join(' / ')
      : '暂无已登记设备';

  const nowMs = Date.now();
  const displayText = detail?.id === selectedItem?.id ? detail?.text ?? '' : '';
  const safeLinkHref =
    selectedItem?.kind === 'link'
      ? isSafeHttpUrl(displayText || selectedItem.preview)
      : null;

  const captureOn = Boolean(status?.capture.running || settings?.captureEnabled);

  return (
    <div className={styles.workspace}>
      <section className={`${styles.hero} hud-panel`} aria-label="剪贴板概览">
        <div className={styles.heroMain}>
          <div className={styles.heroLead}>
            <span className={styles.heroGlyph} aria-hidden>
              <SnippetsOutlined />
            </span>
            <div>
              <div className={styles.eyebrow}>Clipboard // Local Matrix</div>
              <h1 className={styles.heroTitle}>剪贴板</h1>
              <div className={styles.heroSub}>
                {status
                  ? `${status.platform} · ${status.deviceName}`
                  : '正在连接本机 Server…'}
              </div>
            </div>
          </div>

          <div className={styles.heroStats}>
            <span className={styles.statChip}>
              <span className={styles.statValue}>{status?.itemCount ?? items.length}</span>
              <span>记录</span>
            </span>
            <span className={styles.statChip}>
              <span className={styles.statValue}>{status?.pinnedCount ?? 0}</span>
              <span>置顶</span>
            </span>
            <Tooltip title={deviceTooltip}>
              <span className={styles.statChip}>
                <span className={styles.statValue}>{devices.length}</span>
                <span>设备</span>
              </span>
            </Tooltip>
            <span className={`${styles.stateChip} ${captureOn ? styles.stateChipOn : ''}`}>
              <span className={styles.stateDot} />
              {captureOn ? '采集运行中' : '采集已停止'}
            </span>
            {(status?.transports ?? [])
              .filter((transport) => transport.available)
              .map((transport) => (
                <span
                  key={transport.name}
                  className={`${styles.transportChip} ${styles.transportReady}`}
                  title={transport.detail || transport.name}
                >
                  {transport.name}
                </span>
              ))}
          </div>
        </div>

        <div className={styles.heroControls}>
          <span className={styles.controlCluster}>
            <span className={styles.controlLabel}>本机采集</span>
            <Switch
              size="small"
              checked={Boolean(settings?.captureEnabled)}
              disabled={savingSettings || captureUnsupported || !settings}
              onChange={(checked) =>
                void applySettingsPatch(
                  { captureEnabled: checked },
                  checked ? '已开启本机采集' : '已关闭本机采集'
                )
              }
            />
          </span>

          <span className={styles.controlCluster}>
            <span className={styles.controlLabel}>加密同步</span>
            <Switch
              size="small"
              checked={Boolean(settings?.syncEnabled)}
              disabled={savingSettings || !settings}
              onChange={(checked) =>
                void applySettingsPatch(
                  { syncEnabled: checked },
                  checked ? '已开启同步' : '已关闭同步'
                )
              }
            />
          </span>

          <span className={styles.controlCluster}>
            <span className={styles.controlLabel}>目标 Server</span>
            <Select
              size="small"
              className={styles.targetSelect}
              value={settings?.syncTargetProfileId ?? ''}
              disabled={savingSettings || !settings}
              options={serverOptions}
              onChange={(value: string) =>
                void applySettingsPatch(
                  { syncTargetProfileId: value },
                  value ? '已更新同步目标' : '已清除同步目标'
                )
              }
            />
            <Button
              size="small"
              icon={<SyncOutlined spin={syncing} />}
              loading={syncing}
              disabled={!settings?.syncEnabled || !settings?.syncTargetProfileId}
              onClick={() => void handleTriggerSync()}
            >
              立即同步
            </Button>
          </span>

          <span className={styles.keyCluster}>
            <span className={styles.keyLabel}>KEY FP</span>
            <code className={styles.fingerprint}>{status?.keyFingerprint || '未生成'}</code>
          </span>

          {captureUnsupported && (
            <span className={styles.controlHint}>
              {status?.capture.reason || '当前主机不支持桌面采集'}
            </span>
          )}
          {status?.sync.lastSyncAtMs ? (
            <span className={styles.controlHint}>
              上次同步 {formatRelativeTimeZh(status.sync.lastSyncAtMs, nowMs)}
            </span>
          ) : null}
          {feedback && (
            <span
              className={
                feedback.tone === 'danger' ? styles.feedbackDanger : styles.feedback
              }
            >
              {feedback.text}
            </span>
          )}
          {status?.sync.lastError && (
            <span className={styles.feedbackDanger}>同步异常：{status.sync.lastError}</span>
          )}
        </div>
      </section>

      <div className={styles.bodyGrid}>
        <section className={`${styles.listPanel} hud-panel`} aria-label="剪贴板历史列表">
          <div className={styles.listToolbar}>
            <Input
              className={styles.searchInput}
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索预览、路径或 ID…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <div className={styles.filterRow} role="tablist" aria-label="按类型筛选">
              {KIND_OPTIONS.map((option) => {
                const count =
                  option.value === 'all'
                    ? items.length
                    : items.filter((item) => item.kind === option.value).length;
                const active = kindFilter === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`${styles.filterChip} ${
                      active ? styles.filterChipActive : ''
                    }`}
                    onClick={() => setKindFilter(option.value)}
                  >
                    {option.label}
                    <span className={styles.filterCount}>{count}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.listScroll}>
            {loading && items.length === 0 ? (
              <div className={styles.listLoading}>
                <Spin size="small" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className={styles.emptyState}>
                <span className={styles.emptyRing} aria-hidden>
                  <SnippetsOutlined />
                </span>
                <span className={styles.emptyTitle}>
                  {items.length === 0 ? '还没有剪贴板记录' : '没有匹配的条目'}
                </span>
                <span className={styles.emptyHint}>
                  {items.length === 0
                    ? '打开本机采集后复制文本、图片或文件，记录会实时出现在这里。'
                    : '换一个关键词，或切换左侧类型筛选。'}
                </span>
              </div>
            ) : (
              filteredItems.map((item) => {
                const isSelected = selectedItem?.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={isSelected}
                    className={`${styles.listRow} ${
                      isSelected ? styles.listRowSelected : ''
                    }`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <span className={styles.rowGlyph} data-kind={item.kind} aria-hidden>
                      {item.kind === 'image' && item.thumbnailDataUrl ? (
                        <img
                          className={styles.rowGlyphImage}
                          src={item.thumbnailDataUrl}
                          alt=""
                        />
                      ) : (
                        renderKindIcon(item.kind)
                      )}
                    </span>
                    <span className={styles.rowMain}>
                      <span className={styles.rowTitle} title={item.preview}>
                        {item.preview || `(${KIND_LABELS[item.kind]})`}
                      </span>
                      <span className={styles.rowMeta}>
                        <span className={styles.rowKind}>{KIND_LABELS[item.kind]}</span>
                        <span>{formatByteSize(item.byteSize)}</span>
                        <span>{formatRelativeTimeZh(item.lastSeenAtMs, nowMs)}</span>
                      </span>
                    </span>
                    {item.pinned && (
                      <StarFilled className={styles.rowPin} aria-label="已置顶" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          <div className={styles.listFooter}>
            <span>
              显示 {filteredItems.length} / {items.length}
            </span>
            <span>{captureOn ? '实时采集中' : '采集已暂停'}</span>
          </div>
        </section>

        <section className={`${styles.previewPanel} hud-panel`} aria-label="剪贴板内容预览">
          {!selectedItem ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyRing} aria-hidden>
                <EyeOutlined />
              </span>
              <span className={styles.emptyTitle}>选择一条记录</span>
              <span className={styles.emptyHint}>
                右侧会展示完整文本、图片或文件路径，并提供复制、置顶与删除操作。
              </span>
            </div>
          ) : (
            <>
              <div className={styles.previewHead}>
                <div className={styles.previewIdentity}>
                  <span className={styles.kindBadge} data-kind={selectedItem.kind}>
                    {renderKindIcon(selectedItem.kind)}
                    <span>{KIND_LABELS[selectedItem.kind]}</span>
                  </span>
                  <span className={styles.previewMeta}>
                    {formatByteSize(selectedItem.byteSize)}
                    {' · '}
                    {formatRelativeTimeZh(selectedItem.lastSeenAtMs, nowMs)}
                    {' · '}
                    采集 {selectedItem.seenCount} 次
                    {selectedItem.kind === 'image' &&
                    selectedItem.width &&
                    selectedItem.height
                      ? ` · ${selectedItem.width}×${selectedItem.height}`
                      : ''}
                    {selectedItem.sourceApp ? ` · 来源 ${selectedItem.sourceApp}` : ''}
                  </span>
                </div>

                <div className={styles.previewActions}>
                  <Button
                    size="small"
                    type="primary"
                    icon={<CopyOutlined />}
                    loading={acting}
                    onClick={() => void handleCopyItem(selectedItem)}
                  >
                    复制
                  </Button>
                  <Tooltip title={selectedItem.pinned ? '取消置顶' : '置顶'}>
                    <Button
                      size="small"
                      icon={selectedItem.pinned ? <PushpinFilled /> : <PushpinOutlined />}
                      loading={acting}
                      aria-label={selectedItem.pinned ? '取消置顶' : '置顶'}
                      onClick={() => void handleTogglePin(selectedItem)}
                    />
                  </Tooltip>
                  <Popconfirm
                    title="确认删除这条剪贴板记录？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void handleDelete(selectedItem)}
                  >
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={acting}
                      aria-label="删除"
                    />
                  </Popconfirm>
                </div>
              </div>

              <div className={styles.previewBody}>
                <div className={styles.contentSurface} data-kind={selectedItem.kind}>
                  {selectedItem.kind === 'image' ? (
                    <div className={styles.imagePreviewBox}>
                      {selectedItem.thumbnailDataUrl ? (
                        <div className={styles.thumbnailFrame}>
                          <img
                            src={selectedItem.thumbnailDataUrl}
                            alt={selectedItem.preview || '剪贴板图片缩略图'}
                            className={styles.thumbnailImg}
                          />
                        </div>
                      ) : (
                        <div className={styles.thumbnailPlaceholder}>
                          <PictureOutlined style={{ fontSize: 24 }} />
                          <span>暂无缩略图</span>
                        </div>
                      )}
                      <div className={styles.imageActionsRow}>
                        <Button
                          size="small"
                          icon={<EyeOutlined />}
                          onClick={() => void handleOpenOriginalImage(selectedItem)}
                        >
                          查看原图
                        </Button>
                        <Button
                          size="small"
                          icon={<DownloadOutlined />}
                          onClick={() => void handleDownloadImage(selectedItem)}
                        >
                          下载原图
                        </Button>
                        {fallbackDownloadUrl && (
                          <a
                            href={fallbackDownloadUrl}
                            download={fallbackDownloadName}
                            rel="noopener noreferrer"
                          >
                            直接下载 ({fallbackDownloadName})
                          </a>
                        )}
                      </div>
                    </div>
                  ) : selectedItem.kind === 'file' ? (
                    <div className={styles.fileList}>
                      {selectedItem.files && selectedItem.files.length > 0 ? (
                        selectedItem.files.map((filePath) => (
                          <div key={filePath} className={styles.fileRow}>
                            <span className={styles.filePath}>{filePath}</span>
                            <Button
                              size="small"
                              icon={<CopyOutlined />}
                              disabled={acting}
                              onClick={() => void handleCopySinglePath(filePath)}
                            >
                              复制路径
                            </Button>
                          </div>
                        ))
                      ) : (
                        <span className={styles.truncationNote}>该条目没有文件路径记录</span>
                      )}
                    </div>
                  ) : (
                    <>
                      {safeLinkHref && (
                        <div className={styles.linkRow}>
                          <LinkOutlined />
                          <a href={safeLinkHref} target="_blank" rel="noopener noreferrer">
                            {safeLinkHref}
                          </a>
                        </div>
                      )}
                      {detailLoading ? (
                        <div className={styles.listLoading}>
                          <Spin size="small" />
                        </div>
                      ) : (
                        <>
                          <pre className={styles.textPreview}>
                            {displayText || selectedItem.preview}
                          </pre>
                          {detail?.id === selectedItem.id && detail.textTruncated && (
                            <span className={styles.truncationNote}>
                              预览已截断至前 64 KiB；点击「复制」会拉取并复制完整原文。
                            </span>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      <Modal
        open={originalModalOpen}
        title={selectedItem?.preview || '原图预览'}
        footer={null}
        width={820}
        onCancel={handleCloseOriginalModal}
        destroyOnClose
      >
        <div className={styles.modalImageWrap}>
          {originalLoading || !originalUrl ? (
            <Spin />
          ) : (
            <img src={originalUrl} alt="原图" className={styles.modalImage} />
          )}
        </div>
      </Modal>
    </div>
  );
}