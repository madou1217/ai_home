import type { ServerJsonValue } from '../server-transport/contract.ts';
import { AccountManagementError, unsupportedAccountOperation } from './errors.ts';
import type { AccountImportPayload } from './legacy-contract.ts';
import type { ManagedProvider } from './types.ts';

const MAX_IMPORT_TEXT_BYTES = 1024 * 1024;

export interface DecodedNativeImport {
  /** Go 原生导入合同要求的 artifacts（provider 官方 artifact 的 JSON 对象）。 */
  artifacts: ServerJsonValue;
  providerHint: string;
  providerId: ManagedProvider;
}

/**
 * decodeNativeImport 是上传 UI 与 Go 原生导入合同之间的 ACL。
 *
 * 2026-10-23：原先走 sub2api 迁移文档，该格式已废弃（前后端同时移除）。
 * 现在只接受**原生 artifact 文档**：`{"provider_id":"codex","artifacts":{...}}`，
 * 与 Go 的 `/v1/management/account-imports` 完全同形，前端不再做格式翻译。
 */
export function decodeNativeImport(payload: AccountImportPayload): DecodedNativeImport {
  const { text, providerHint } = importTextFromPayload(payload);
  const document = decodeNativeArtifactDocument(text);
  return { ...document, providerHint };
}

function importTextFromPayload(payload: AccountImportPayload): {
  text: string;
  providerHint: string;
} {
  const providerHint = String(payload.provider || '').trim();
  if ('content' in payload) return { text: String(payload.content || ''), providerHint };
  if (payload.files.length !== 1) {
    return unsupportedAccountOperation('account_management_bulk_import_unsupported');
  }
  const file = payload.files[0];
  if (!file || file.contentBase64 || file.encoding === 'base64' || typeof file.content !== 'string') {
    return unsupportedAccountOperation('account_management_binary_import_unsupported');
  }
  return { text: file.content, providerHint };
}

/** 解析一份原生 artifact 文档，并校验 provider 与形状。 */
function decodeNativeArtifactDocument(textValue: string): {
  artifacts: ServerJsonValue;
  providerId: ManagedProvider;
} {
  const text = String(textValue || '');
  if (!text.trim() || new TextEncoder().encode(text).byteLength > MAX_IMPORT_TEXT_BYTES) {
    throw new AccountManagementError('account_management_import_document_invalid', 422);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    throw new AccountManagementError('account_management_import_document_invalid', 422);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountManagementError('account_management_import_document_invalid', 422);
  }
  const document = value as Record<string, unknown>;
  const providerId = asManagedProviderOrThrow(document.provider_id);
  const artifacts = document.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new AccountManagementError('account_management_import_document_invalid', 422);
  }
  return { artifacts: artifacts as ServerJsonValue, providerId };
}

/** 原生导入只支持有官方 artifact 转换策略的 provider。 */
function asManagedProviderOrThrow(value: unknown): ManagedProvider {
  if (value === 'codex' || value === 'claude') return value;
  return unsupportedAccountOperation<ManagedProvider>(
    'account_management_import_provider_unsupported'
  );
}
