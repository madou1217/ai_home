import type { ServerJsonValue } from '../server-transport/contract.ts';
import { AccountManagementError, unsupportedAccountOperation } from './errors.ts';
import type { AccountImportPayload } from './legacy-contract.ts';
import type { ManagedProvider } from './types.ts';

const MAX_IMPORT_TEXT_BYTES = 1024 * 1024;

export interface DecodedSub2APIImport {
  document: ServerJsonValue;
  providerHint: string;
  providerId: ManagedProvider;
}
// decodeLegacySub2APIImport 是上传 UI 与严格单账号 Go 导入合同之间的 ACL。
export function decodeLegacySub2APIImport(payload: AccountImportPayload): DecodedSub2APIImport {
  const { text, providerHint } = importTextFromLegacy(payload);
  const document = decodeSingleSub2APIDocument(text);
  return { ...document, providerHint };
}

function importTextFromLegacy(payload: AccountImportPayload): {
  text: string;
  providerHint: string;
} {
  if ('mode' in payload && payload.mode === 'cliproxyapi') {
    return unsupportedAccountOperation('account_management_cliproxy_import_unsupported');
  }
  const providerHint = String(payload.provider || '').trim();
  if ('content' in payload) return { text: String(payload.content || ''), providerHint };
  if (payload.uploadKind === 'folder' || payload.files.length !== 1) {
    return unsupportedAccountOperation('account_management_bulk_import_unsupported');
  }
  const file = payload.files[0];
  if (!file || file.contentBase64 || file.encoding === 'base64' || typeof file.content !== 'string') {
    return unsupportedAccountOperation('account_management_binary_import_unsupported');
  }
  return { text: file.content, providerHint };
}

function decodeSingleSub2APIDocument(textValue: string): {
  document: ServerJsonValue;
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
  if (
    document.type !== 'sub2api-data'
    || !Array.isArray(document.accounts)
    || document.accounts.length !== 1
    || !Array.isArray(document.proxies)
    || document.proxies.length !== 0
  ) {
    throw new AccountManagementError('account_management_import_single_account_required', 422);
  }
  const account = document.accounts[0];
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw new AccountManagementError('account_management_import_document_invalid', 422);
  }
  const platform = (account as Record<string, unknown>).platform;
  const providerId = platform === 'openai'
    ? 'codex'
    : platform === 'anthropic'
      ? 'claude'
      : unsupportedAccountOperation<ManagedProvider>(
        'account_management_import_provider_unsupported'
      );
  return { document: value as ServerJsonValue, providerId };
}
