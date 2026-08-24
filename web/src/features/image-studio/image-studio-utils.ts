import type {
  ImageStudioAsset,
  ImageStudioModel,
  ImageStudioRevision,
  ImageStudioRevisionMode,
  ImageStudioRunInput,
  ImageStudioSession,
} from '@/types';

export const IMAGE_STUDIO_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const IMAGE_STUDIO_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const IMAGE_STUDIO_REQUEST_METADATA_RESERVE_BYTES = 256 * 1024;
export const IMAGE_STUDIO_ASSET_MAX_AUTO_ATTEMPTS = 3;
export const IMAGE_STUDIO_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

export function imageStudioAssetKey(sessionId: string, assetId: string) {
  return `${sessionId}:${assetId}`;
}

export function shouldAutoRetryImageStudioAsset(attemptCount: number) {
  return Math.max(0, Math.trunc(Number(attemptCount) || 0)) < IMAGE_STUDIO_ASSET_MAX_AUTO_ATTEMPTS;
}

export function pruneImageStudioAssetUrls(
  cache: Map<string, string>,
  activeKeys: ReadonlySet<string>,
  revoke: (url: string) => void,
) {
  let removed = 0;
  cache.forEach((url, key) => {
    if (activeKeys.has(key)) return;
    revoke(url);
    cache.delete(key);
    removed += 1;
  });
  return removed;
}

export function selectInitialImageStudioModel(
  models: ImageStudioModel[],
  preferredKey = '',
  defaultKey = '',
) {
  const preferred = models.find((model) => model.key === preferredKey && model.availableAccountCount > 0);
  if (preferred) return preferred.key;
  const advertised = models.find((model) => model.key === defaultKey && model.availableAccountCount > 0);
  if (advertised) return advertised.key;
  return models.find((model) => model.availableAccountCount > 0)?.key || models[0]?.key || '';
}

export function getImageStudioQualityOptions(
  model: Pick<ImageStudioModel, 'capabilities' | 'qualityOptions'> | null | undefined,
) {
  if (!model?.capabilities.quality) return ['auto'];
  const options = Array.from(new Set((model.qualityOptions || [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => value && value !== 'auto')));
  return ['auto', ...options];
}

export function getImageStudioSourceLimit(
  model: Pick<ImageStudioModel, 'capabilities'> | null | undefined,
) {
  return Math.max(1, Number(model?.capabilities.maxInputImages) || 1);
}

export function validateImageStudioSourceCount(
  currentCount: number,
  incomingCount: number,
  model: Pick<ImageStudioModel, 'capabilities'> | null | undefined,
) {
  const limit = getImageStudioSourceLimit(model);
  return Math.max(0, currentCount) + Math.max(0, incomingCount) <= limit
    ? ''
    : `当前模型最多 ${limit} 张参考图`;
}

export interface ImageStudioRevisionDraft {
  modelKey: string;
  mode: ImageStudioRevisionMode;
  prompt: string;
  outputCount: number;
  size: string;
  quality: string;
  sourceAssetIds: string[];
  maskAssetId: string;
  background: string;
  outputFormat: string;
  outputCompression: number;
  moderation: string;
  parentRevisionId: string;
}

export function buildImageStudioRevisionDraft(
  models: ImageStudioModel[],
  revision: ImageStudioRevision,
): ImageStudioRevisionDraft | null {
  const sourceAssetIds = revision.mode === 'edit' ? revision.sourceAssetIds || [] : [];
  const supportsMode = (model: ImageStudioModel) => {
    if (revision.mode === 'generation') return model.capabilities.generation;
    return model.capabilities.edit
      && Math.max(1, Number(model.capabilities.maxInputImages) || 1) >= sourceAssetIds.length;
  };
  const selectedModel = models.find((model) => (
    model.key === revision.modelKey
    && model.availableAccountCount > 0
    && supportsMode(model)
  )) || models.find((model) => model.availableAccountCount > 0 && supportsMode(model));
  if (!selectedModel) return null;

  const desiredQuality = String(revision.parameters?.quality || '').trim().toLowerCase() || 'auto';
  const qualityOptions = getImageStudioQualityOptions(selectedModel);
  const persistedCompression = revision.parameters?.outputCompression;
  const desiredCompression = persistedCompression == null ? Number.NaN : Number(persistedCompression);
  return {
    modelKey: selectedModel.key,
    mode: revision.mode,
    prompt: revision.prompt,
    outputCount: selectedModel.capabilities.multiple
      ? Math.max(1, Number(revision.parameters?.n) || 1)
      : 1,
    size: selectedModel.capabilities.size
      ? String(revision.parameters?.size || '').trim() || 'auto'
      : 'auto',
    quality: qualityOptions.includes(desiredQuality) ? desiredQuality : 'auto',
    sourceAssetIds,
    maskAssetId: revision.mode === 'edit' && selectedModel.capabilities.mask ? revision.maskAssetId : '',
    background: selectedModel.capabilities.background
      ? String(revision.parameters?.background || '').trim() || 'auto'
      : 'auto',
    outputFormat: selectedModel.capabilities.outputFormat
      ? String(revision.parameters?.outputFormat || '').trim() || 'png'
      : 'png',
    outputCompression: selectedModel.capabilities.outputCompression
      && Number.isInteger(desiredCompression)
      && desiredCompression >= 0
      && desiredCompression <= 100
      ? desiredCompression
      : 100,
    moderation: selectedModel.capabilities.moderation
      ? String(revision.parameters?.moderation || '').trim() || 'auto'
      : 'auto',
    parentRevisionId: revision.mode === 'edit' ? revision.parentRevisionId : '',
  };
}

export function formatImageStudioModelAvailability(model: Pick<
  ImageStudioModel,
  'accountCount' | 'availableAccountCount' | 'unavailableReasons'
>) {
  const total = Math.max(0, Number(model.accountCount) || 0);
  const available = Math.max(0, Number(model.availableAccountCount) || 0);
  if (available > 0) return `${available}/${total} 个账号可用`;

  const buckets = {
    quota: 0,
    threshold: 0,
    policy: 0,
    auth: 0,
    cooldown: 0,
    credential: 0,
    other: 0,
  };
  (model.unavailableReasons || []).forEach((entry) => {
    const reason = String(entry?.reason || '').toLowerCase();
    const count = Math.max(0, Number(entry?.count) || 0);
    if (!count) return;
    if (reason.includes('codex_usage_below_server_threshold')) buckets.threshold += count;
    else if (reason.includes('blocked_by_quota') || reason.includes('quota_exhausted') || reason.includes('usage_exhausted')) buckets.quota += count;
    else if (reason.includes('auth_invalid') || reason.includes('token_expired')) buckets.auth += count;
    else if (reason.includes('cooldown') || reason.includes('rate_limit')) buckets.cooldown += count;
    else if (reason.includes('credential_missing')) buckets.credential += count;
    else if (reason.includes('blocked_by_policy')) buckets.policy += count;
    else buckets.other += count;
  });

  const details = [
    buckets.quota ? `${buckets.quota} 个账号额度已用尽` : '',
    buckets.threshold ? `${buckets.threshold} 个账号低于服务器额度保护阈值` : '',
    buckets.policy ? `${buckets.policy} 个账号被服务器策略暂停` : '',
    buckets.auth ? `${buckets.auth} 个账号登录已失效` : '',
    buckets.cooldown ? `${buckets.cooldown} 个账号冷却中` : '',
    buckets.credential ? `${buckets.credential} 个账号缺少可用凭据` : '',
    buckets.other ? `${buckets.other} 个账号当前不可调度` : '',
  ].filter(Boolean);
  return details.join('；') || '当前没有可调度账号';
}

export function mapAssetsById(session: ImageStudioSession | null | undefined) {
  return new Map(
    (session?.assets || []).map((asset) => [asset.id, asset] as const),
  );
}

export function getRevisionPreviewAssetId(revision: ImageStudioRevision | null | undefined) {
  return revision?.outputAssetIds?.[0] || revision?.sourceAssetIds?.[0] || '';
}

export function getLatestRevisionId(session: ImageStudioSession | null | undefined) {
  const revisions = session?.revisions || [];
  const activeRevisionId = String(session?.activeRevisionId || '').trim();
  if (activeRevisionId && revisions.some((revision) => revision.id === activeRevisionId)) {
    return activeRevisionId;
  }
  return revisions[revisions.length - 1]?.id || '';
}

export function resolveSelectedRevision(
  session: ImageStudioSession | null | undefined,
  revisionId: string,
) {
  const revisions = session?.revisions || [];
  return revisions.find((revision) => revision.id === revisionId)
    || revisions.find((revision) => revision.id === getLatestRevisionId(session))
    || null;
}

export function resolveSelectedAsset(
  session: ImageStudioSession | null | undefined,
  revision: ImageStudioRevision | null | undefined,
  assetId: string,
): ImageStudioAsset | null {
  const assets = mapAssetsById(session);
  const allowedIds = new Set([
    ...(revision?.outputAssetIds || []),
    ...(revision?.sourceAssetIds || []),
  ].filter(Boolean));
  const requested = allowedIds.has(assetId) ? assets.get(assetId) : null;
  if (requested) return requested;
  const fallbackId = getRevisionPreviewAssetId(revision);
  return fallbackId ? assets.get(fallbackId) || null : null;
}

export function imageFileExtension(mimeType: string) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  return 'png';
}

export function formatAssetSize(byteLength: number) {
  const bytes = Math.max(0, Number(byteLength) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRevisionClock(timestamp: number) {
  const date = new Date(Number(timestamp) || 0);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function makeRevisionDownloadName(
  session: ImageStudioSession,
  revision: ImageStudioRevision,
  asset: ImageStudioAsset,
) {
  const safeTitle = String(session.title || 'image-studio')
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image-studio';
  const revisionIndex = Math.max(1, session.revisions.findIndex((item) => item.id === revision.id) + 1);
  return `${safeTitle}-r${String(revisionIndex).padStart(2, '0')}.${imageFileExtension(asset.mimeType)}`;
}

export function validateImageStudioUpload(
  file: Pick<File, 'size' | 'type'>,
  kind: 'source' | 'mask' = 'source',
) {
  const mimeType = String(file.type || '').toLowerCase();
  if (kind === 'mask' && mimeType !== 'image/png') return '遮罩仅支持 PNG 图片';
  if (!IMAGE_STUDIO_ALLOWED_MIME_TYPES.has(mimeType)) return '仅支持 PNG、JPEG 与 WebP 图片';
  if (file.size > IMAGE_STUDIO_MAX_UPLOAD_BYTES) return '图片不能超过 4 MiB';
  return '';
}

export function validateImageStudioUploadBudget(rawByteLengths: number[]) {
  const estimatedEncodedBytes = (rawByteLengths || []).reduce((total, value) => {
    const bytes = Math.max(0, Math.trunc(Number(value) || 0));
    return total + (4 * Math.ceil(bytes / 3)) + 64;
  }, 0);
  return estimatedEncodedBytes <= IMAGE_STUDIO_REQUEST_BODY_BYTES - IMAGE_STUDIO_REQUEST_METADATA_RESERVE_BYTES
    ? ''
    : '所选本地图片经 Base64 编码后会超过 16 MiB 请求上限，请减少图片数量或大小';
}

interface BuildImageStudioRunInputOptions {
  model: ImageStudioModel;
  mode: ImageStudioRevisionMode;
  prompt: string;
  parentRevisionId?: string;
  sources?: ImageStudioRunInput['sources'];
  maskAssetId?: string;
  maskImage?: string;
  n: number;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  outputCompression: number;
  moderation: string;
}

export function buildImageStudioRunInput(options: BuildImageStudioRunInputOptions): ImageStudioRunInput {
  const {
    model,
    mode,
    prompt,
    parentRevisionId = '',
    sources = [],
    maskAssetId = '',
    maskImage = '',
    n,
    size,
    quality,
    background,
    outputFormat,
    outputCompression,
    moderation,
  } = options;
  const isEdit = mode === 'edit';
  return {
    mode,
    modelKey: model.key,
    prompt: prompt.trim(),
    ...(isEdit && parentRevisionId ? { parentRevisionId } : {}),
    ...(isEdit && sources.length > 0 ? { sources } : {}),
    ...(isEdit && model.capabilities.mask && maskAssetId ? { maskAssetId } : {}),
    ...(isEdit && model.capabilities.mask && !maskAssetId && maskImage ? { mask: maskImage } : {}),
    n: model.capabilities.multiple ? n : 1,
    ...(model.capabilities.size && size && size !== 'auto' ? { size } : {}),
    ...(model.capabilities.quality && quality && quality !== 'auto' ? { quality } : {}),
    ...(model.capabilities.background && background ? { background } : {}),
    ...(model.capabilities.outputFormat && outputFormat ? { output_format: outputFormat } : {}),
    ...(model.capabilities.outputCompression
      && (outputFormat === 'jpeg' || outputFormat === 'webp')
      && Number.isInteger(outputCompression)
      ? { output_compression: outputCompression }
      : {}),
    ...(model.capabilities.moderation && moderation ? { moderation } : {}),
  };
}
