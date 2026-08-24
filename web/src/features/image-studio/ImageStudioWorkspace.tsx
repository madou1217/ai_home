import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SelectOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import { Button, Input, Modal, Spin, Tooltip, message } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { imageStudioAPI } from '@/services/api';
import { buildAppHref } from '@/services/app-navigation';
import type {
  ImageStudioAsset,
  ImageStudioModel,
  ImageStudioRevision,
  ImageStudioRevisionMode,
  ImageStudioSession,
  ImageStudioSessionSummary,
} from '@/types';
import ImageStudioCanvas from './ImageStudioCanvas';
import ImageStudioComposer, {
  type ImageStudioSourcePreview,
  type ImageStudioUploadValue,
} from './ImageStudioComposer';
import ImageStudioRevisionStrip from './ImageStudioRevisionStrip';
import ImageStudioSessionRail from './ImageStudioSessionRail';
import { useImageStudioAssetUrls, type ImageStudioAssetRequest } from './use-image-studio-assets';
import {
  buildImageStudioRevisionDraft,
  buildImageStudioRunInput,
  getImageStudioQualityOptions,
  getImageStudioSourceLimit,
  getLatestRevisionId,
  getRevisionPreviewAssetId,
  imageStudioAssetKey,
  makeRevisionDownloadName,
  mapAssetsById,
  resolveSelectedAsset,
  resolveSelectedRevision,
  selectInitialImageStudioModel,
  validateImageStudioUpload,
  validateImageStudioUploadBudget,
  validateImageStudioSourceCount,
} from './image-studio-utils';
import styles from './image-studio.module.css';

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('image_file_read_failed'));
    reader.readAsDataURL(file);
  });
}

function errorMessage(error: unknown) {
  const candidate = error as {
    message?: string;
    response?: { data?: { detail?: string; error?: string } };
  };
  return candidate?.response?.data?.detail
    || candidate?.response?.data?.error
    || candidate?.message
    || '请求失败';
}

interface ImageStudioSourceSelection {
  key: string;
  assetId?: string;
  upload?: ImageStudioUploadValue;
}

let sourceUploadSequence = 0;

function uploadedSourceSelection(file: File, upload: ImageStudioUploadValue): ImageStudioSourceSelection {
  sourceUploadSequence += 1;
  return {
    key: `upload:${Date.now()}:${sourceUploadSequence}:${file.name}`,
    upload,
  };
}

function storedSourceSelection(assetId: string): ImageStudioSourceSelection {
  return { key: `asset:${assetId}`, assetId };
}

const ImageStudioWorkspace: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSessionId = searchParams.get('session') || '';
  const initialSessionId = useRef(searchParams.get('session') || '');
  const modelsRef = useRef<ImageStudioModel[]>([]);
  const activeSessionIdRef = useRef('');
  const [models, setModels] = useState<ImageStudioModel[]>([]);
  const [sessions, setSessions] = useState<ImageStudioSessionSummary[]>([]);
  const [session, setSession] = useState<ImageStudioSession | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [mode, setMode] = useState<ImageStudioRevisionMode>('generation');
  const [prompt, setPrompt] = useState('');
  const [outputCount, setOutputCount] = useState(1);
  const [size, setSize] = useState('auto');
  const [quality, setQuality] = useState('auto');
  const [background, setBackground] = useState('auto');
  const [outputFormat, setOutputFormat] = useState('png');
  const [outputCompression, setOutputCompression] = useState(100);
  const [moderation, setModeration] = useState('auto');
  const [sourceSelections, setSourceSelections] = useState<ImageStudioSourceSelection[]>([]);
  const [maskAssetId, setMaskAssetId] = useState('');
  const [parentRevisionId, setParentRevisionId] = useState('');
  const [maskUpload, setMaskUpload] = useState<ImageStudioUploadValue | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [switchingSession, setSwitchingSession] = useState(false);
  const [running, setRunning] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const setSelectionFromSession = useCallback((
    nextSession: ImageStudioSession,
    preferredRevisionId = '',
    preferredAssetId = '',
  ) => {
    const nextRevisionId = nextSession.revisions.some((revision) => revision.id === preferredRevisionId)
      ? preferredRevisionId
      : getLatestRevisionId(nextSession);
    const nextRevision = resolveSelectedRevision(nextSession, nextRevisionId);
    const nextAsset = resolveSelectedAsset(nextSession, nextRevision, preferredAssetId);
    activeSessionIdRef.current = nextSession.id;
    setSession(nextSession);
    setSelectedRevisionId(nextRevision?.id || '');
    setSelectedAssetId(nextAsset?.id || '');
  }, []);

  const resetComposerForSession = useCallback(() => {
    setMode('generation');
    setPrompt('');
    setSourceSelections([]);
    setMaskAssetId('');
    setParentRevisionId('');
    setMaskUpload(null);
    setBackground('auto');
    setOutputFormat('png');
    setOutputCompression(100);
    setModeration('auto');
  }, []);

  const applyModelCatalog = useCallback((
    nextModels: ImageStudioModel[],
    defaultKey = '',
    preferredKey = '',
  ) => {
    modelsRef.current = nextModels;
    setModels(nextModels);
    setModelKey((current) => selectInitialImageStudioModel(
      nextModels,
      preferredKey || current,
      defaultKey,
    ));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      setInitializing(true);
      try {
        const [modelResponse, sessionResponse] = await Promise.all([
          imageStudioAPI.listModels(),
          imageStudioAPI.listSessions(),
        ]);
        if (cancelled) return;
        setSessions(sessionResponse.sessions || []);

        let nextSession: ImageStudioSession | null = null;
        const requestedId = initialSessionId.current;
        if (requestedId) {
          try {
            nextSession = (await imageStudioAPI.getSession(requestedId)).session;
          } catch (_error) {
            nextSession = null;
          }
        }
        if (!nextSession && sessionResponse.sessions?.[0]?.id) {
          nextSession = (await imageStudioAPI.getSession(sessionResponse.sessions[0].id)).session;
        }
        if (!nextSession) {
          nextSession = (await imageStudioAPI.createSession()).session;
          const refreshed = await imageStudioAPI.listSessions();
          if (!cancelled) setSessions(refreshed.sessions || []);
        }
        if (cancelled) return;
        setSelectionFromSession(nextSession);
        const latestRevision = resolveSelectedRevision(nextSession, getLatestRevisionId(nextSession));
        applyModelCatalog(
          modelResponse.models || [],
          modelResponse.defaultModelKey,
          latestRevision?.modelKey,
        );
        setSearchParams({ session: nextSession.id }, { replace: true });
      } catch (error) {
        if (!cancelled) message.error(`影像工作台初始化失败：${errorMessage(error)}`);
      } finally {
        if (!cancelled) setInitializing(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [applyModelCatalog, setSearchParams, setSelectionFromSession]);

  useEffect(() => {
    if (initializing || !requestedSessionId || requestedSessionId === session?.id) return undefined;
    let cancelled = false;
    const loadRequestedSession = async () => {
      setSwitchingSession(true);
      try {
        const response = await imageStudioAPI.getSession(requestedSessionId);
        if (cancelled) return;
        setSelectionFromSession(response.session);
        resetComposerForSession();
        const latest = resolveSelectedRevision(response.session, getLatestRevisionId(response.session));
        setModelKey((current) => selectInitialImageStudioModel(
          modelsRef.current,
          latest?.modelKey,
          current,
        ));
      } catch (error) {
        if (cancelled) return;
        message.error(`会话载入失败：${errorMessage(error)}`);
        if (session?.id) setSearchParams({ session: session.id }, { replace: true });
      } finally {
        if (!cancelled) setSwitchingSession(false);
      }
    };
    void loadRequestedSession();
    return () => {
      cancelled = true;
    };
  }, [
    initializing,
    requestedSessionId,
    resetComposerForSession,
    session?.id,
    setSearchParams,
    setSelectionFromSession,
  ]);

  useEffect(() => {
    const selectedModel = models.find((model) => model.key === modelKey);
    if (!selectedModel) return;
    if (!selectedModel.capabilities.edit && mode === 'edit') {
      setMode('generation');
      setSourceSelections([]);
      setParentRevisionId('');
    }
    if (!selectedModel.capabilities.mask) {
      setMaskAssetId('');
      setMaskUpload(null);
    }
    if (!selectedModel.capabilities.multiple) setOutputCount(1);
    if (!selectedModel.capabilities.size) setSize('auto');
    if (!getImageStudioQualityOptions(selectedModel).includes(quality)) setQuality('auto');
    if (!selectedModel.capabilities.background) setBackground('auto');
    if (!selectedModel.capabilities.outputFormat) setOutputFormat('png');
    if (!selectedModel.capabilities.outputCompression) setOutputCompression(100);
    if (!selectedModel.capabilities.moderation) setModeration('auto');
    if (outputFormat === 'jpeg' && background === 'transparent') setBackground('auto');
  }, [background, mode, modelKey, models, outputFormat, quality]);

  useEffect(() => {
    if (!session?.id || running) return undefined;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const [detail, list, modelResponse] = await Promise.all([
          imageStudioAPI.getSession(session.id),
          imageStudioAPI.listSessions(),
          imageStudioAPI.listModels(),
        ]);
        if (cancelled) return;
        setSessions(list.sessions || []);
        applyModelCatalog(modelResponse.models || [], modelResponse.defaultModelKey);
        setSelectionFromSession(detail.session, selectedRevisionId, selectedAssetId);
      } catch (_error) {
        // 其他窗口可能正在写入；下个轮询周期继续同步。
      }
    };
    const timer = window.setInterval(() => void refresh(), 6000);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [applyModelCatalog, running, selectedAssetId, selectedRevisionId, session?.id, setSelectionFromSession]);

  const selectedRevision = useMemo(
    () => resolveSelectedRevision(session, selectedRevisionId),
    [selectedRevisionId, session],
  );
  const selectedAsset = useMemo(
    () => resolveSelectedAsset(session, selectedRevision, selectedAssetId),
    [selectedAssetId, selectedRevision, session],
  );
  const sessionAssets = useMemo(() => mapAssetsById(session), [session]);
  const selectedModel = useMemo(
    () => models.find((model) => model.key === modelKey) || null,
    [modelKey, models],
  );

  const assetRequests = useMemo(() => {
    const requests = new Map<string, ImageStudioAssetRequest>();
    const add = (sessionId: string, assetId: string, mimeType: string) => {
      if (!sessionId || !assetId) return;
      requests.set(imageStudioAssetKey(sessionId, assetId), { sessionId, assetId, mimeType });
    };
    sessions.forEach((item) => add(item.id, item.previewAssetId, item.previewMimeType || 'image/png'));
    if (session) {
      session.revisions.forEach((revision) => {
        const asset = sessionAssets.get(getRevisionPreviewAssetId(revision));
        if (asset) add(session.id, asset.id, asset.mimeType);
      });
      [...(selectedRevision?.sourceAssetIds || []), selectedRevision?.maskAssetId, ...(selectedRevision?.outputAssetIds || [])]
        .filter(Boolean)
        .forEach((assetId) => {
          const asset = sessionAssets.get(String(assetId));
          if (asset) add(session.id, asset.id, asset.mimeType);
        });
      [...sourceSelections.map((source) => source.assetId), maskAssetId]
        .filter((assetId): assetId is string => Boolean(assetId))
        .forEach((assetId) => {
          const asset = sessionAssets.get(assetId);
          if (asset) add(session.id, asset.id, asset.mimeType);
        });
    }
    return [...requests.values()];
  }, [maskAssetId, selectedRevision, session, sessionAssets, sessions, sourceSelections]);
  const assetUrls = useImageStudioAssetUrls(assetRequests);

  const sourceLimit = getImageStudioSourceLimit(selectedModel);
  const sourcePreviews = useMemo<ImageStudioSourcePreview[]>(() => sourceSelections.map((source) => {
    if (source.upload) {
      return {
        key: source.key,
        previewUrl: source.upload.dataUrl,
        label: source.upload.name,
      };
    }
    const asset = source.assetId ? sessionAssets.get(source.assetId) : null;
    return {
      key: source.key,
      previewUrl: session && asset ? assetUrls[imageStudioAssetKey(session.id, asset.id)] || '' : '',
      label: asset ? `修订资产 · ${asset.id.slice(-8)}` : '正在载入修订资产',
    };
  }), [assetUrls, session, sessionAssets, sourceSelections]);
  const maskAsset = maskAssetId ? sessionAssets.get(maskAssetId) || null : null;
  const maskPreviewUrl = maskUpload?.dataUrl
    || (session && maskAsset ? assetUrls[imageStudioAssetKey(session.id, maskAsset.id)] : '')
    || '';

  const refreshSessionList = async () => {
    try {
      const response = await imageStudioAPI.listSessions();
      setSessions(response.sessions || []);
    } catch (_error) {
      // 会话写入已经完成；列表会由轮询继续同步，避免把辅助刷新误报成生成失败。
    }
  };

  const handleSelectSession = (sessionId: string) => {
    if (!sessionId || sessionId === session?.id) return;
    setSearchParams({ session: sessionId });
  };

  const handleRefreshCurrent = async () => {
    if (!session) return;
    setSwitchingSession(true);
    try {
      const [detail, list, modelResponse] = await Promise.all([
        imageStudioAPI.getSession(session.id),
        imageStudioAPI.listSessions(),
        imageStudioAPI.listModels(),
      ]);
      setSessions(list.sessions || []);
      applyModelCatalog(modelResponse.models || [], modelResponse.defaultModelKey);
      setSelectionFromSession(detail.session, selectedRevisionId, selectedAssetId);
    } catch (error) {
      message.error(`会话刷新失败：${errorMessage(error)}`);
    } finally {
      setSwitchingSession(false);
    }
  };

  const handleCreateSession = async () => {
    try {
      const response = await imageStudioAPI.createSession();
      setSelectionFromSession(response.session);
      resetComposerForSession();
      await refreshSessionList();
      setSearchParams({ session: response.session.id });
    } catch (error) {
      message.error(`新建会话失败：${errorMessage(error)}`);
    }
  };

  const handleOpenWindow = (sessionId: string) => {
    const href = buildAppHref('/studio/image', `session=${encodeURIComponent(sessionId)}`);
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  const handleSourceFiles = async (files: File[]) => {
    if (files.length < 1) return;
    const countValidation = validateImageStudioSourceCount(
      sourceSelections.length,
      files.length,
      selectedModel,
    );
    if (countValidation) {
      message.warning(countValidation);
      return;
    }
    const invalidFile = files
      .map((file) => ({ file, validation: validateImageStudioUpload(file) }))
      .find((entry) => entry.validation);
    if (invalidFile) {
      message.warning(`${invalidFile.file.name}：${invalidFile.validation}`);
      return;
    }
    const budgetValidation = validateImageStudioUploadBudget([
      ...sourceSelections.flatMap((source) => source.upload ? [source.upload.size] : []),
      ...(maskUpload ? [maskUpload.size] : []),
      ...files.map((file) => file.size),
    ]);
    if (budgetValidation) {
      message.warning(budgetValidation);
      return;
    }
    try {
      const uploads = await Promise.all(files.map(async (file) => uploadedSourceSelection(file, {
        name: file.name,
        dataUrl: await readFileAsDataUrl(file),
        mimeType: file.type,
        size: file.size,
      })));
      setSourceSelections((current) => [...current, ...uploads]);
      if (sourceSelections.length < 1) setParentRevisionId('');
    } catch (error) {
      message.error(`图片读取失败：${errorMessage(error)}`);
    }
  };

  const handleMaskFile = async (file: File) => {
    const validation = validateImageStudioUpload(file, 'mask');
    if (validation) {
      message.warning(validation);
      return;
    }
    const budgetValidation = validateImageStudioUploadBudget([
      ...sourceSelections.flatMap((source) => source.upload ? [source.upload.size] : []),
      file.size,
    ]);
    if (budgetValidation) {
      message.warning(budgetValidation);
      return;
    }
    try {
      setMaskUpload({
        name: file.name,
        dataUrl: await readFileAsDataUrl(file),
        mimeType: file.type,
        size: file.size,
      });
      setMaskAssetId('');
    } catch (error) {
      message.error(`图片读取失败：${errorMessage(error)}`);
    }
  };

  const handleRemoveSource = (key: string) => {
    const removedIndex = sourceSelections.findIndex((source) => source.key === key);
    if (removedIndex < 0) return;
    setSourceSelections(sourceSelections.filter((source) => source.key !== key));
    if (removedIndex === 0) {
      setParentRevisionId('');
      setMaskAssetId('');
      setMaskUpload(null);
    }
  };

  const handleRun = async () => {
    if (!session || !selectedModel) return;
    const budgetValidation = validateImageStudioUploadBudget([
      ...sourceSelections.flatMap((source) => source.upload ? [source.upload.size] : []),
      ...(maskUpload ? [maskUpload.size] : []),
    ]);
    if (budgetValidation) {
      message.warning(budgetValidation);
      return;
    }
    const runSessionId = session.id;
    const runMode = mode;
    setRunning(true);
    try {
      const response = await imageStudioAPI.run(runSessionId, buildImageStudioRunInput({
        model: selectedModel,
        mode: runMode,
        prompt,
        parentRevisionId,
        sources: sourceSelections.map((source) => (source.assetId
          ? { assetId: source.assetId }
          : { image: source.upload?.dataUrl || '' })),
        maskAssetId,
        maskImage: maskUpload?.dataUrl,
        n: outputCount,
        size,
        quality,
        background,
        outputFormat,
        outputCompression,
        moderation,
      }));
      const revision = response.session.revisions.find((item) => item.id === response.revisionId) || null;
      const assetId = revision?.outputAssetIds?.[0] || '';
      if (activeSessionIdRef.current === runSessionId) {
        setSelectionFromSession(response.session, response.revisionId, assetId);
        if (runMode === 'edit' && assetId) {
          setSourceSelections([storedSourceSelection(assetId)]);
          setParentRevisionId(response.revisionId);
          setMaskAssetId('');
          setMaskUpload(null);
        }
      }
      await refreshSessionList();
      message.success(runMode === 'edit' ? '编辑修订已保存' : '新修订已保存');
    } catch (error) {
      if (activeSessionIdRef.current === runSessionId) {
        try {
          const detail = await imageStudioAPI.getSession(runSessionId);
          setSelectionFromSession(detail.session);
        } catch (_refreshError) {}
      }
      await refreshSessionList();
      message.error(`图片处理失败：${errorMessage(error)}`);
    } finally {
      setRunning(false);
    }
  };

  const handleContinueEdit = (revision: ImageStudioRevision, asset: ImageStudioAsset) => {
    const editModel = models.find((model) => model.key === revision.modelKey && model.capabilities.edit && model.availableAccountCount > 0)
      || models.find((model) => model.capabilities.edit && model.availableAccountCount > 0);
    if (!editModel) {
      message.warning('当前没有可用的图片编辑模型');
      return;
    }
    setModelKey(editModel.key);
    setMode('edit');
    setSourceSelections([storedSourceSelection(asset.id)]);
    setMaskAssetId('');
    setMaskUpload(null);
    setParentRevisionId(revision.id);
    setPrompt(revision.prompt);
    message.info('已将当前输出放入编辑源图，可直接修改指令继续迭代');
  };

  const handleReuseRevision = (revision: ImageStudioRevision) => {
    const draft = buildImageStudioRevisionDraft(models, revision);
    if (!draft) {
      message.warning('当前没有可复用该修订的可用模型');
      return;
    }
    setModelKey(draft.modelKey);
    setMode(draft.mode);
    setPrompt(draft.prompt);
    setOutputCount(draft.outputCount);
    setSize(draft.size);
    setQuality(draft.quality);
    setBackground(draft.background);
    setOutputFormat(draft.outputFormat);
    setOutputCompression(draft.outputCompression);
    setModeration(draft.moderation);
    setSourceSelections(draft.sourceAssetIds.map(storedSourceSelection));
    setMaskAssetId(draft.maskAssetId);
    setParentRevisionId(draft.parentRevisionId);
    setMaskUpload(null);
    message.info('已复用失败修订的有效参数，可调整后重新提交');
  };

  const handleDownload = (revision: ImageStudioRevision, asset: ImageStudioAsset) => {
    if (!session) return;
    const url = assetUrls[imageStudioAssetKey(session.id, asset.id)];
    if (!url) {
      message.info('原图仍在载入，请稍后重试');
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = makeRevisionDownloadName(session, revision, asset);
    anchor.click();
  };

  const handleCopyPrompt = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success('提示词已复制');
    } catch (_error) {
      message.error('浏览器未允许写入剪贴板');
    }
  };

  const handleRename = async () => {
    if (!session || !renameValue.trim()) return;
    try {
      const response = await imageStudioAPI.renameSession(session.id, renameValue.trim());
      setSession(response.session);
      await refreshSessionList();
      setRenameOpen(false);
    } catch (error) {
      message.error(`重命名失败：${errorMessage(error)}`);
    }
  };

  const handleDeleteSession = async (targetSession: ImageStudioSession) => {
    try {
      await imageStudioAPI.deleteSession(targetSession.id);
      let list = await imageStudioAPI.listSessions();
      let nextSession: ImageStudioSession;
      if (list.sessions?.[0]?.id) {
        nextSession = (await imageStudioAPI.getSession(list.sessions[0].id)).session;
      } else {
        nextSession = (await imageStudioAPI.createSession()).session;
        list = await imageStudioAPI.listSessions();
      }
      setSessions(list.sessions || []);
      setSelectionFromSession(nextSession);
      resetComposerForSession();
      setSearchParams({ session: nextSession.id }, { replace: true });
      message.success('影像会话及其资产已删除');
    } catch (error) {
      message.error(`删除会话失败：${errorMessage(error)}`);
      throw error;
    }
  };

  const confirmDeleteSession = () => {
    if (!session) return;
    const targetSession = session;
    Modal.confirm({
      title: '删除影像会话',
      content: `将永久删除“${targetSession.title}”及其 ${targetSession.assets.length} 个图片资产。`,
      okText: '删除',
      cancelText: '取消',
      okType: 'danger',
      onOk: () => handleDeleteSession(targetSession),
    });
  };

  const sessionHasRunningRevision = Boolean(
    running || session?.revisions.some((revision) => revision.status === 'running'),
  );

  if (initializing) {
    return (
      <PageContainer title={false} className={styles.pageContainer}>
        <div className={styles.initialLoading} role="status">
          <Spin size="large" />
          <span>正在装载影像会话与模型目录…</span>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={false} className={styles.pageContainer}>
      <div className={styles.workspace}>
        <header className={styles.workspaceHeader}>
          <div className={styles.workspaceIdentity}>
            <span className={styles.workspaceMark}>IMG/</span>
            <div>
              <span className={styles.eyebrow}>AI HOME · IMAGE STUDIO</span>
              <h1>{session?.title || '影像工作台'}</h1>
            </div>
            {switchingSession && <Spin size="small" />}
          </div>
          <div className={styles.workspaceActions}>
            <span className={styles.workspaceReadout}>
              {models.filter((model) => model.availableAccountCount > 0).length}/{models.length} MODELS ONLINE
            </span>
            <Tooltip title="重命名当前会话">
              <Button
                icon={<EditOutlined />}
                disabled={!session}
                onClick={() => {
                  setRenameValue(session?.title || '');
                  setRenameOpen(true);
                }}
              />
            </Tooltip>
            <Tooltip title="在新窗口打开当前会话">
              <Button icon={<SelectOutlined />} disabled={!session} onClick={() => session && handleOpenWindow(session.id)} />
            </Tooltip>
            <Tooltip title="刷新会话">
              <Button
                icon={<ReloadOutlined />}
                disabled={!session || running}
                onClick={handleRefreshCurrent}
              />
            </Tooltip>
            <Tooltip title={sessionHasRunningRevision ? '运行中的会话不能删除' : '删除当前会话'}>
              <Button
                danger
                icon={<DeleteOutlined />}
                disabled={!session || sessionHasRunningRevision}
                onClick={confirmDeleteSession}
              />
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateSession}>新会话</Button>
          </div>
        </header>

        <div className={styles.workspaceGrid}>
          <ImageStudioSessionRail
            sessions={sessions}
            activeSessionId={session?.id || ''}
            assetUrls={assetUrls}
            onCreate={handleCreateSession}
            onSelect={handleSelectSession}
            onOpenWindow={handleOpenWindow}
          />

          <main className={styles.workspaceMain}>
            <ImageStudioCanvas
              session={session}
              revision={selectedRevision}
              selectedAsset={selectedAsset}
              assetUrls={assetUrls}
              running={running}
              onSelectAsset={setSelectedAssetId}
              onContinueEdit={handleContinueEdit}
              onReuseRevision={handleReuseRevision}
              onDownload={handleDownload}
              onCopyPrompt={handleCopyPrompt}
            />
            <ImageStudioRevisionStrip
              session={session}
              selectedRevisionId={selectedRevision?.id || ''}
              assetUrls={assetUrls}
              onSelect={(revision) => {
                setSelectedRevisionId(revision.id);
                setSelectedAssetId(getRevisionPreviewAssetId(revision));
              }}
            />
          </main>

          <ImageStudioComposer
            models={models}
            modelKey={modelKey}
            mode={mode}
            prompt={prompt}
            n={outputCount}
            size={size}
            quality={quality}
            background={background}
            outputFormat={outputFormat}
            outputCompression={outputCompression}
            moderation={moderation}
            sources={sourcePreviews}
            sourceLimit={sourceLimit}
            maskPreviewUrl={maskPreviewUrl}
            maskLabel={maskUpload?.name || (maskAsset ? `遮罩资产 · ${maskAsset.id.slice(-8)}` : '')}
            running={running}
            onModelChange={setModelKey}
            onModeChange={setMode}
            onPromptChange={setPrompt}
            onNChange={setOutputCount}
            onSizeChange={setSize}
            onQualityChange={setQuality}
            onBackgroundChange={setBackground}
            onOutputFormatChange={setOutputFormat}
            onOutputCompressionChange={setOutputCompression}
            onModerationChange={setModeration}
            onSourceFiles={handleSourceFiles}
            onMaskFile={handleMaskFile}
            onRemoveSource={handleRemoveSource}
            onClearMask={() => {
              setMaskAssetId('');
              setMaskUpload(null);
            }}
            onSubmit={handleRun}
          />
        </div>
      </div>

      <Modal
        title="重命名影像会话"
        open={renameOpen}
        okText="保存"
        cancelText="取消"
        onOk={handleRename}
        onCancel={() => setRenameOpen(false)}
        okButtonProps={{ disabled: !renameValue.trim() }}
      >
        <Input value={renameValue} maxLength={120} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
      </Modal>
    </PageContainer>
  );
};

export default ImageStudioWorkspace;
