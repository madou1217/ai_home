import api from './api';

export interface InstallationBackupFile {
  path: string;
  sha256: string;
  size: number;
}

export interface InstallationBackupWeb {
  path: string;
  sha256: string;
  files: number;
  bytes: number;
}

export interface InstallationBackupEntry {
  version: number;
  id: string;
  createdAt: string;
  label?: string;
  server?: InstallationBackupFile;
  cli?: InstallationBackupFile;
  web?: InstallationBackupWeb;
}

export interface InstallationBackupSnapshot {
  ok: boolean;
  current: InstallationBackupEntry;
  entries: InstallationBackupEntry[];
  maxEntries: number;
  root: string;
  created?: InstallationBackupEntry;
  restored?: InstallationBackupEntry;
}

const base = '/webui/installation-backups';

export async function getInstallationBackups(signal?: AbortSignal): Promise<InstallationBackupSnapshot> {
  const response = await api.get<InstallationBackupSnapshot>(base, { signal });
  return response.data;
}

export async function createInstallationBackup(label = ''): Promise<InstallationBackupSnapshot> {
  const response = await api.post<InstallationBackupSnapshot>(base, { confirm: true, label });
  return response.data;
}

export async function restoreInstallationBackup(id: string): Promise<InstallationBackupSnapshot> {
  const response = await api.post<InstallationBackupSnapshot>(
    `${base}/${encodeURIComponent(id)}/restore`,
    { confirm: true }
  );
  return response.data;
}

export async function deleteInstallationBackup(id: string): Promise<InstallationBackupSnapshot> {
  const response = await api.delete<InstallationBackupSnapshot>(
    `${base}/${encodeURIComponent(id)}`,
    { params: { confirm: 1 } }
  );
  return response.data;
}

export async function restartAiHomeServer(): Promise<void> {
  await api.post('/webui/server/restart');
}

export function installationBackupErrorMessage(error: unknown): string {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 401) return '当前连接未授权，请先配置 Management Key。';
  if (status === 409) return '备份文件校验失败或服务端状态冲突。';
  if (status === 400) return '该操作需要显式确认。';
  return '操作失败，请稍后重试。';
}
