import type { AccountImportJob, AccountImportResponse } from '@/types';

// 账号导入导出 —— 常量与进度格式化纯函数模块。
// 从 Accounts.tsx 抽取：导入模式/粘贴模板/导出动作集中于此，
// 组件只负责弹窗交互与触发导入导出。

export type ImportMode = 'file' | 'text';

/** 导出范围：全部 / 某个 provider / 单个账号。格式只有一种：aih 本机原生账号文件。 */
export interface AccountExportScope {
  readonly provider?: string;
  readonly accountRef?: string;
}

export const EXPORT_ACTIONS: Array<{ key: string; label: string; description: string; scope: AccountExportScope }> = [
  {
    key: 'all',
    label: '导出全部账号',
    description: '下载 aih 账号文件（含明文凭据），可在另一台 aih 的「导入」或 aih import 中使用。',
    scope: {}
  }
];

export function formatImportResult(result: AccountImportResponse) {
  const summary = result.summary;
  const imported = Number(summary?.imported ?? result.imported ?? 0);
  if (!summary) return `导入完成，写入 ${imported} 个账号`;

  const parts = [`写入 ${imported}`];
  if (summary.created > 0) parts.push(`新增 ${summary.created}`);
  if (summary.updated > 0) parts.push(`更新 ${summary.updated}`);
  if (summary.skipped > 0) parts.push(`跳过 ${summary.skipped}`);
  if (summary.invalid > 0) parts.push(`无效 ${summary.invalid}`);
  if (summary.failed > 0) parts.push(`失败 ${summary.failed}`);
  return `导入完成：${parts.join('，')}`;
}

export function buildImportResponseFromJob(job: AccountImportJob): AccountImportResponse {
  return {
    ok: true,
    imported: Number(job.summary?.imported || 0),
    summary: job.summary,
    result: job.result
  };
}

export function formatImportJobProgress(job: AccountImportJob | null) {
  if (!job) return '';
  const progress = job.progress;
  if (!progress) return job.status === 'queued' ? '等待后台导入开始' : '后台导入中';
  const percent = Number(progress.percent || 0);
  const label = String(progress.label || '').trim();
  return `${percent}%${label ? ` · ${label}` : ''}`;
}
/* ---------------------------------------------------------------------------
 * 文件 / 文件夹上传：浏览器 File → 导入接口的 upload 负载
 * ------------------------------------------------------------------------ */

export type ImportUploadKind = 'file' | 'folder';

/** 文件选择器的 accept：aih 账号文件是 JSON。 */
export const IMPORT_FILE_ACCEPT = '.json,application/json';

interface ImportFileLike {
  name: string;
  webkitRelativePath?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/**
 * 把选中的文件读成导入接口的 upload 条目：一律 base64（ZIP 是二进制，JSON 也走同一通道，
 * 服务端 normalizeUploadedFiles 统一解码）；文件夹上传保留 webkitRelativePath 目录结构。
 */
export async function readImportUploadFiles(files: ArrayLike<ImportFileLike>) {
  const list = Array.from(files);
  return Promise.all(list.map(async (file) => ({
    name: file.name,
    relativePath: String(file.webkitRelativePath || '').trim() || file.name,
    contentBase64: encodeBytesToBase64(new Uint8Array(await file.arrayBuffer())),
    encoding: 'base64' as const
  })));
}

/** 导入弹窗里「已选择 …」的展示名：单文件为文件名，文件夹为顶层目录名 + 文件数。 */
export function describeImportSelection(files: ArrayLike<Pick<ImportFileLike, 'name' | 'webkitRelativePath'>>, kind: ImportUploadKind) {
  const list = Array.from(files);
  if (list.length === 0) return '';
  if (kind === 'folder') {
    const root = String(list[0].webkitRelativePath || '').split('/')[0] || list[0].name;
    return `${root}（${list.length} 个文件）`;
  }
  return list.length === 1 ? list[0].name : `${list[0].name} 等 ${list.length} 个文件`;
}
