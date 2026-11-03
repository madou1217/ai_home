const SAFE_ERROR_CODE = /^[a-z][a-z0-9_.:-]{0,95}$/i;

// AccountManagementError 只保留稳定码和 HTTP 状态，不持有请求体或原始异常。
export class AccountManagementError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly response: {
    status?: number;
    data: {
      ok: false;
      error: string;
      code: string;
      message: string;
    };
  };

  constructor(code: string, status?: number) {
    const safeCode = SAFE_ERROR_CODE.test(code) ? code : 'account_management_failed';
    super(safeCode);
    this.name = 'AccountManagementError';
    this.code = safeCode;
    this.status = Number.isInteger(status) ? status : undefined;
    this.response = {
      ...(this.status !== undefined ? { status: this.status } : {}),
      data: {
        ok: false,
        error: safeCode,
        code: safeCode,
        message: publicErrorMessage(safeCode, this.status)
      }
    };
  }
}

// asAccountManagementError 丢弃未知异常内容，避免凭据进入 UI 日志或错误提示。
export function asAccountManagementError(error: unknown): AccountManagementError {
  if (error instanceof AccountManagementError) return error;
  if (!error || typeof error !== 'object') {
    return new AccountManagementError('account_management_transport_failed');
  }
  const source = error as Record<string, unknown>;
  const status = typeof source.status === 'number' && Number.isInteger(source.status)
    ? source.status
    : undefined;
  return new AccountManagementError('account_management_transport_failed', status);
}

// formatAccountManagementError 返回可展示的固定文案，绝不拼接服务端 message 或凭据。
export function formatAccountManagementError(error: unknown): string {
  const normalized = asAccountManagementError(error);
  return publicErrorMessage(normalized.code, normalized.status);
}

export function unsupportedAccountOperation<T>(code: string): T {
  throw new AccountManagementError(code, 422);
}

function publicErrorMessage(code: string, status?: number): string {
  if (status === 401 || code === 'unauthorized') {
    return '当前 Server 的 Management Key 无效或缺失';
  }
  if (code.endsWith('_unsupported') || code.includes('operation_unsupported')) {
    return '当前 Go 账号管理链暂不支持该操作';
  }
  if (code.includes('import_')) return '仅支持导入单份 sub2api JSON 账号文档';
  if (status === 404) return '账号管理资源不存在';
  if (status === 409) return '账号管理操作发生冲突';
  if (status === 429) return '账号管理请求过于频繁，请稍后重试';
  if (status !== undefined && status >= 500) {
    return '账号管理服务暂时不可用';
  }
  return '账号管理操作失败';
}
