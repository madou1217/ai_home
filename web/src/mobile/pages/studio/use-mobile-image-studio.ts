import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message, Modal } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { imageStudioAPI } from '@/services/api';
import type {
  ImageStudioAsset,
  ImageStudioModel,
  ImageStudioRevision,
  ImageStudioRevisionMode,
  ImageStudioSession,
  ImageStudioSessionSummary,
} from '@/types';
import type { ImageStudioUploadValue } from '@/features/image-studio/ImageStudioComposer';
import { useImageStudioAssetUrls, type ImageStudioAssetRequest } from '@/features/image-studio/use-image-studio-assets';
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
  validateImageStudioSourceCount,
  validateImageStudioUpload,
  validateImageStudioUploadBudget,
} from '@/features/image-studio/image-studio-utils';

/**
 * 移动端影像工作台的数据层。
 *
 * 与桌面 ImageStudioWorkspace 调用同一组 imageStudioAPI（listModels / listSessions / getSession /
 * createSession / renameSession / deleteSession / run / getAssetBlob）、同一套 image-studio-utils
 * 校验与请求构造、同样的提示文案与 6 秒轮询。桌面工作台的这些处理函数被契约测试
 * （test/web.image-studio-contract.test.js）固定在 ImageStudioWorkspace.tsx 内，因此移动端单独持有一份，
 * 行为逐项对齐；差异只在导航：移动端是「会话列表 → 会话视图」，未选会话时停在列表，不自动新建。
 */

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

interface SourceSelection {
  key: string;
  assetId?: string;
  upload?: ImageStudioUploadValue;
}

export interface MobileSourcePreview {
  key: string;
  previewUrl: string;
  label: string;
}

let sourceUploadSequence = 0;

function uploadedSelection(file: File, upload: ImageStudioUploadValue): SourceSelection {
  sourceUploadSequence += 1;
  return { key: `upload:${Date.now()}:${sourceUploadSequence}:${file.name}`, upload };
}

function storedSelection(assetId: string): SourceSelection {
  return { key: `asset:${assetId}`, assetId };
}

export function useMobileImageStudio() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSessionId = searchParams.get('session') || '';
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
  const [sourceSelections, setSourceSelections] = useState<SourceSelection[]>([]);
  const [maskAssetId, setMaskAssetId] = useState('');
  const [parentRevisionId, setParentRevisionId] = useState('');
  const [maskUpload, setMaskUpload] = useState<ImageStudioUploadValue | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [initError, setInitError] = useState('');
  const [switchingSession, setSwitchingSession] = useState(false);
  const [refreshingList, setRefreshingList] = useState(false);
  const [running, setRunning] = useState(false);

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
    setModelKey((current) => selectInitialImageStudioModel(nextModels, preferredKey || current, defaultKey));
  }, []);

  const loadCatalog = useCallback(async () => {
    const [modelResponse, sessionResponse] = await Promise.all([
      imageStudioAPI.listModels(),
      imageStudioAPI.listSessions(),
    ]);
    setSessions(sessionResponse.sessions || []);
    applyModelCatalog(modelResponse.models || [], modelResponse.defaultModelKey);
  }, [applyModelCatalog]);

  // 首次装载：模型目录 + 会话列表（与桌面同一组请求；不自动创建会话）。
  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      setInitializing(true);
      setInitError('');
      try {
        await loadCatalog();
      } catch (error) {
        if (!cancelled) {
          setInitError(errorMessage(error));
          message.error(`影像工作台初始化失败：${errorMessage(error)}`);
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [loadCatalog]);

  // URL ?session= 驱动会话视图：切换时载入会话并重置控制台，模型优先沿用最新修订的路线。
  useEffect(() => {
    if (!requestedSessionId) {
      activeSessionIdRef.current = '';
      setSession(null);
      setSelectedRevisionId('');
      setSelectedAssetId('');
      return undefined;
    }
    if (initializing || requestedSessionId === session?.id) return undefined;
    let cancelled = false;
    const loadRequestedSession = async () => {
      setSwitchingSession(true);
      try {
        const response = await imageStudioAPI.getSession(requestedSessionId);
        if (cancelled) return;
        setSelectionFromSession(response.session);
        resetComposerForSession();
        const latest = resolveSelectedRevision(response.session, getLatestRevisionId(response.session));
        setModelKey((current) => selectInitialImageStudioModel(modelsRef.current, latest?.modelKey, current));
      } catch (error) {
        if (cancelled) return;
        message.error(`会话载入失败：${errorMessage(error)}`);
        setSearchParams({}, { replace: true });
      } finally {
        if (!cancelled) setSwitchingSession(false);
      }
    };
    void loadRequestedSession();
    return () => {
      cancelled = true;
    };
  }, [initializing, requestedSessionId, resetComposerForSession, session?.id, setSearchParams, setSelectionFromSession]);

  // 模型能力变化时收敛参数（与桌面相同的降级规则）。
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

  // 6 秒轮询 + 回到前台时同步（其他窗口可能正在写入）；运行中暂停，避免覆盖进行中的选择。
  useEffect(() => {
    if (initializing || running) return undefined;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        if (session?.id) {
          const [detail, list, modelResponse] = await Promise.all([
            imageStudioAPI.getSession(session.id),
            imageStudioAPI.listSessions(),
            imageStudioAPI.listModels(),
          ]);
          if (cancelled) return;
          setSessions(list.sessions || []);
          applyModelCatalog(modelResponse.models || [], modelResponse.defaultModelKey);
          setSelectionFromSession(detail.session, selectedRevisionId, selectedAssetId);
        } else {
          const [list, modelResponse] = await Promise.all([
            imageStudioAPI.listSessions(),
            imageStudioAPI.listModels(),
          ]);
          if (cancelled) return;
          setSessions(list.sessions || []);
          applyModelCatalog(modelResponse.models || [], modelResponse.defaultModelKey);
        }
      } catch (_error) {
        // 下个轮询周期继续同步。
      }
    };
    const timer = window.setInterval(() => void refresh(), 6000);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [applyModelCatalog, initializing, running, selectedAssetId, selectedRevisionId, session?.id, setSelectionFromSession]);

  const selectedRevision = useMemo(() => resolveSelectedRevision(session, selectedRevisionId), [selectedRevisionId, session]);
  const selectedAsset = useMemo(
    () => resolveSelectedAsset(session, selectedRevision, selectedAssetId),
    [selectedAssetId, selectedRevision, session],
  );
  const sessionAssets = useMemo(() => mapAssetsById(session), [session]);
  const selectedModel = useMemo(() => models.find((model) => model.key === modelKey) || null, [modelKey, models]);

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
  const sourcePreviews = useMemo<MobileSourcePreview[]>(() => sourceSelections.map((source) => {
    if (source.upload) {
      return { key: source.key, previewUrl: source.upload.dataUrl, label: source.upload.name };
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
  const maskLabel = maskUpload?.name || (maskAsset ? `遮罩资产 · ${maskAsset.id.slice(-8)}` : '');

  const refreshSessionList = async () => {
    try {
      const response = await imageStudioAPI.listSessions();
      setSessions(response.sessions || []);
    } catch (_error) {
      // 会话写入已经完成；列表由轮询继续同步。
    }
  };

  const openSession = (sessionId: string) => {
    if (!sessionId) return;
    setSearchParams({ session: sessionId });
  };

  const closeSession = () => {
    setSearchParams({});
  };

  const refreshList = async () => {
    setRefreshingList(true);
    try {
      await loadCatalog();
      setInitError('');
    } catch (error) {
      message.error(`会话刷新失败：${errorMessage(error)}`);
    } finally {
      setRefreshingList(false);
    }
  };

  const refreshCurrent = async () => {
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

  const createSession = async () => {
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

  const addSourceFiles = async (files: File[]) => {
    if (files.length < 1) return;
    const countValidation = validateImageStudioSourceCount(sourceSelections.length, files.length, selectedModel);
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
      const uploads = await Promise.all(files.map(async (file) => uploadedSelection(file, {
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

  const setMaskFile = async (file: File) => {
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
      setMaskUpload({ name: file.name, dataUrl: await readFileAsDataUrl(file), mimeType: file.type, size: file.size });
      setMaskAssetId('');
    } catch (error) {
      message.error(`图片读取失败：${errorMessage(error)}`);
    }
  };

  const removeSource = (key: string) => {
    const removedIndex = sourceSelections.findIndex((source) => source.key === key);
    if (removedIndex < 0) return;
    setSourceSelections(sourceSelections.filter((source) => source.key !== key));
    if (removedIndex === 0) {
      setParentRevisionId('');
      setMaskAssetId('');
      setMaskUpload(null);
    }
  };

  const clearMask = () => {
    setMaskAssetId('');
    setMaskUpload(null);
  };

  const run = async () => {
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
          setSourceSelections([storedSelection(assetId)]);
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

  const continueEdit = (revision: ImageStudioRevision, asset: ImageStudioAsset) => {
    const editModel = models.find((model) => model.key === revision.modelKey && model.capabilities.edit && model.availableAccountCount > 0)
      || models.find((model) => model.capabilities.edit && model.availableAccountCount > 0);
    if (!editModel) {
      message.warning('当前没有可用的图片编辑模型');
      return;
    }
    setModelKey(editModel.key);
    setMode('edit');
    setSourceSelections([storedSelection(asset.id)]);
    setMaskAssetId('');
    setMaskUpload(null);
    setParentRevisionId(revision.id);
    setPrompt(revision.prompt);
    message.info('已将当前输出放入编辑源图，可直接修改指令继续迭代');
  };

  const reuseRevision = (revision: ImageStudioRevision) => {
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
    setSourceSelections(draft.sourceAssetIds.map(storedSelection));
    setMaskAssetId(draft.maskAssetId);
    setParentRevisionId(draft.parentRevisionId);
    setMaskUpload(null);
    message.info('已复用失败修订的有效参数，可调整后重新提交');
  };

  const download = (revision: ImageStudioRevision, asset: ImageStudioAsset) => {
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

  const copyPrompt = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success('提示词已复制');
    } catch (_error) {
      message.error('浏览器未允许写入剪贴板');
    }
  };

  const renameSession = async (title: string) => {
    if (!session || !title.trim()) return false;
    try {
      const response = await imageStudioAPI.renameSession(session.id, title.trim());
      setSession(response.session);
      await refreshSessionList();
      return true;
    } catch (error) {
      message.error(`重命名失败：${errorMessage(error)}`);
      return false;
    }
  };

  const sessionHasRunningRevision = Boolean(
    running || session?.revisions.some((revision) => revision.status === 'running'),
  );

  const confirmDeleteSession = () => {
    if (!session) return;
    const targetSession = session;
    Modal.confirm({
      title: '删除影像会话',
      content: `将永久删除“${targetSession.title}”及其 ${targetSession.assets.length} 个图片资产。`,
      okText: '删除',
      cancelText: '取消',
      okType: 'danger',
      onOk: async () => {
        try {
          await imageStudioAPI.deleteSession(targetSession.id);
          const list = await imageStudioAPI.listSessions();
          setSessions(list.sessions || []);
          resetComposerForSession();
          setSearchParams({}, { replace: true });
          message.success('影像会话及其资产已删除');
        } catch (error) {
          message.error(`删除会话失败：${errorMessage(error)}`);
          throw error;
        }
      },
    });
  };

  const selectRevision = (revision: ImageStudioRevision) => {
    setSelectedRevisionId(revision.id);
    setSelectedAssetId(getRevisionPreviewAssetId(revision));
  };

  return {
    requestedSessionId,
    models,
    sessions,
    session,
    selectedRevision,
    selectedAsset,
    selectedModel,
    assetUrls,
    modelKey,
    setModelKey,
    mode,
    setMode,
    prompt,
    setPrompt,
    outputCount,
    setOutputCount,
    size,
    setSize,
    quality,
    setQuality,
    background,
    setBackground,
    outputFormat,
    setOutputFormat,
    outputCompression,
    setOutputCompression,
    moderation,
    setModeration,
    sourcePreviews,
    sourceLimit,
    maskPreviewUrl,
    maskLabel,
    initializing,
    initError,
    switchingSession,
    refreshingList,
    running,
    sessionHasRunningRevision,
    openSession,
    closeSession,
    refreshList,
    refreshCurrent,
    createSession,
    addSourceFiles,
    setMaskFile,
    removeSource,
    clearMask,
    run,
    continueEdit,
    reuseRevision,
    download,
    copyPrompt,
    renameSession,
    confirmDeleteSession,
    selectRevision,
    setSelectedAssetId,
  };
}

export type MobileImageStudio = ReturnType<typeof useMobileImageStudio>;
