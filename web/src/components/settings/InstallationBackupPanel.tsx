import { useCallback, useEffect, useState } from 'react';
import { Button, Modal, message } from 'antd';
import { DeleteOutlined, HistoryOutlined, PlusOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import SectionCard from '@/components/ui/SectionCard';
import { resolveActiveServerOrigin } from '@/services/webui-auth-transport';
import {
  createInstallationBackup,
  deleteInstallationBackup,
  getInstallationBackups,
  installationBackupErrorMessage,
  restartAiHomeServer,
  restoreInstallationBackup,
  type InstallationBackupEntry,
  type InstallationBackupSnapshot
} from '@/services/installation-backup';
import styles from './InstallationBackupPanel.module.css';

function formatBytes(value?: number): string {
  if (!value || value <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date);
}

function shortHash(value?: string): string {
  return value ? value.slice(0, 10) : '—';
}

function matchesCurrent(entry: InstallationBackupEntry, current: InstallationBackupEntry): boolean {
  return Boolean(
    entry.server?.sha256 && current.server?.sha256 && entry.server.sha256 === current.server.sha256
    && entry.web?.sha256 === current.web?.sha256
  );
}

async function waitForServerReady(timeoutMs = 90_000): Promise<boolean> {
  const origin = resolveActiveServerOrigin();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/readyz`, { cache: 'no-store' });
      if (response.ok) {
        const body = await response.json().catch(() => null);
        if (body?.ready) return true;
      }
    } catch {
      // 重启窗口内连接失败是预期状态，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

export default function InstallationBackupPanel() {
  const [snapshot, setSnapshot] = useState<InstallationBackupSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [restartPending, setRestartPending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await getInstallationBackups());
    } catch (failure) {
      setError(installationBackupErrorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setPending('create');
    setError('');
    try {
      await createInstallationBackup();
      message.success('已创建运行文件备份');
      await load();
    } catch (failure) {
      setError(installationBackupErrorMessage(failure));
    } finally {
      setPending('');
    }
  };

  const handleDelete = (entry: InstallationBackupEntry) => {
    Modal.confirm({
      title: '删除这份备份？',
      content: '删除后无法恢复该时间点的程序与 Web UI。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setPending(entry.id);
        try {
          await deleteInstallationBackup(entry.id);
          message.success('备份已删除');
          await load();
        } catch (failure) {
          setError(installationBackupErrorMessage(failure));
        } finally {
          setPending('');
        }
      }
    });
  };

  const restartAndWait = async () => {
    setRestartPending(true);
    setError('');
    try {
      await restartAiHomeServer();
      const ready = await waitForServerReady();
      if (!ready) {
        setError('服务未在 90 秒内恢复，请检查 Server 日志后手动重启。');
        return false;
      }
      message.success('服务已重启');
      await load();
      return true;
    } catch (failure) {
      setError(installationBackupErrorMessage(failure));
      return false;
    } finally {
      setRestartPending(false);
    }
  };

  const handleRestore = (entry: InstallationBackupEntry) => {
    Modal.confirm({
      title: '恢复这份备份并重启服务？',
      content: '将覆盖服务器程序与 Web UI 文件（不含账号、数据库与日志），随后重启 AI Home Server。当前未备份的文件改动会丢失。',
      okText: '恢复并重启',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setPending(entry.id);
        setError('');
        try {
          await restoreInstallationBackup(entry.id);
          message.loading({ content: '文件已恢复，正在重启服务…', key: 'installation-backup-restart', duration: 0 });
          const ready = await restartAndWait();
          message.destroy('installation-backup-restart');
          if (!ready) throw new Error('restart_failed');
        } catch (failure) {
          message.destroy('installation-backup-restart');
          setError(failure instanceof Error && failure.message === 'restart_failed'
            ? '恢复已完成，但服务未能确认重启；可在下方重试重启。'
            : installationBackupErrorMessage(failure));
          throw failure;
        } finally {
          setPending('');
        }
      }
    });
  };

  const current = snapshot?.current;
  return (
    <SectionCard title="运行文件备份" extra={(
      <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
        刷新
      </Button>
    )}>
      <div className={styles.panel}>
        <div className={styles.summary}>
          <span>
            备份 aih-server、aih-go 与 Web UI；不含账号、数据库与日志。
          </span>
          <span className={styles.muted}>
            当前：server {shortHash(current?.server?.sha256)} · cli {shortHash(current?.cli?.sha256)} · Web{' '}
            {current?.web ? `${current.web.files} 文件 / ${formatBytes(current.web.bytes)}` : '未托管'}
          </span>
        </div>

        <div className={styles.actions}>
          <Button type="primary" size="small" icon={<PlusOutlined />} loading={pending === 'create'} onClick={() => void handleCreate()}>
            创建备份
          </Button>
          <span className={styles.muted}>
            最多保留 {snapshot?.maxEntries ?? 5} 份；创建新备份会自动清理最旧的一份。
          </span>
        </div>

        {error ? (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <Button size="small" loading={restartPending} onClick={() => void restartAndWait()}>
              重启服务
            </Button>
          </div>
        ) : null}

        {snapshot && snapshot.entries.length === 0 ? (
          <div className={styles.empty}>
            <HistoryOutlined />
            <span>还没有备份。创建一份后，可在这里一键恢复并重启。</span>
          </div>
        ) : null}

        <div className={styles.rows}>
          {(snapshot?.entries || []).map((entry) => {
            const isCurrent = current ? matchesCurrent(entry, current) : false;
            const busy = pending === entry.id;
            return (
              <div className={styles.row} key={entry.id}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <strong>{formatTime(entry.createdAt)}</strong>
                    {isCurrent ? <span className={styles.currentTag}>当前</span> : null}
                    {entry.label ? <span className={styles.muted}>{entry.label}</span> : null}
                  </div>
                  <div className={styles.meta}>
                    <span>server {shortHash(entry.server?.sha256)}</span>
                    <span>cli {shortHash(entry.cli?.sha256)}</span>
                    <span>Web {entry.web ? `${entry.web.files} 文件 / ${formatBytes(entry.web.bytes)}` : '未包含'}</span>
                    <span className={styles.hash} title={entry.web?.sha256}>{entry.id}</span>
                  </div>
                </div>
                <div className={styles.rowActions}>
                  <Button
                    size="small"
                    icon={<RollbackOutlined />}
                    disabled={busy || isCurrent || restartPending}
                    onClick={() => handleRestore(entry)}
                  >
                    恢复并重启
                  </Button>
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={busy || restartPending}
                    onClick={() => handleDelete(entry)}
                  >
                    删除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </SectionCard>
  );
}
