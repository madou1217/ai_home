import type { AccountExportFormat } from '@/services/api';
import type { AccountImportJob, AccountImportResponse } from '@/types';

// 账号导入导出 —— 常量与进度格式化纯函数模块。
// 从 Accounts.tsx 抽取：导入模式/粘贴模板/导出动作集中于此，
// 组件只负责弹窗交互与触发导入导出。

export type ImportMode = 'file' | 'folder' | 'text' | 'cliproxyapi';
export type PasteTemplate = 'sub2api' | 'antigravity' | 'jsonl';

export const EXPORT_ACTIONS: Array<{ format: AccountExportFormat; label: string; description: string }> = [
  {
    format: 'sub2api',
    label: '导出为迁移 JSON',
    description: '使用 sub2api-data 结构，不导出 AIH 本地身份字段。'
  },
  {
    format: 'antigravity',
    label: '导出为 Antigravity Manager JSON',
    description: '导出 AGY OAuth 账号，适配 Antigravity Manager。'
  },
  {
    format: 'cliproxyapi',
    label: '导出为 CLIProxyAPI 数据',
    description: '下载 JSON 数据文件，不写入本机 CLIProxyAPI 配置。'
  }
];

export const PASTE_TEMPLATES: Record<PasteTemplate, { label: string; description: string; value: string }> = {
  sub2api: {
    label: '迁移 JSON',
    description: '粘贴 sub2api-data JSON；本地账号 ID 会重新分配，冲突时按身份去重。',
    value: JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      proxies: [],
      accounts: [
        {
          name: 'codex-main',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            email: 'user@example.com',
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            id_token: 'id-token',
            chatgpt_account_id: 'chatgpt-account-id'
          }
        }
      ]
    }, null, 2)
  },
  antigravity: {
    label: 'Antigravity Manager',
    description: '粘贴 Antigravity Manager JSON，账号会导入到 AGY provider。',
    value: JSON.stringify({
      accounts: [
        {
          email: 'user@example.com',
          refresh_token: 'agy-refresh-token'
        }
      ]
    }, null, 2)
  },
  jsonl: {
    label: 'JSONL / 单账号',
    description: '每行一个账号 JSON，适合手工合并多个来源。',
    value: [
      JSON.stringify({
        provider: 'codex',
        config: {
          OPENAI_API_KEY: 'sk-...',
          OPENAI_BASE_URL: 'https://api.openai.com/v1'
        }
      }),
      JSON.stringify({
        provider: 'gemini',
        auth: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          client_id: 'client-id',
          email: 'user@example.com'
        }
      })
    ].join('\n')
  }
};

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