import { LoadingOutlined } from '@ant-design/icons';
import type { SshConnection } from '@/features/ssh-hosts/ssh-hosts-model';
import type { SshTestState } from '@/features/ssh-hosts/use-ssh-hosts';
import { KeyValue } from '@/mobile/ui';
import styles from './fabric.module.css';

const DEPENDENCIES: Array<{ key: 'node' | 'npm' | 'git' | 'aih'; label: string }> = [
  { key: 'node', label: 'Node.js' },
  { key: 'npm', label: 'Npm' },
  { key: 'git', label: 'Git' },
  { key: 'aih', label: 'AIH Agent' }
];

/**
 * 连接诊断结果（sshHostsAPI.testConnection 的真实返回）：状态结论、平台 / 架构、依赖检测、诊断建议。
 * 文案与桌面诊断抽屉一致。
 */
export default function SshDiagnostics({ connection, state }: { connection: SshConnection; state?: SshTestState }) {
  if (!state) return <p className={styles.note}>等待测试连接...</p>;
  if (state.loading) {
    return (
      <p className={styles.note} role="status">
        <LoadingOutlined /> 正在连接远程主机并执行依赖诊断，请稍后...
      </p>
    );
  }
  const result = state.result;
  if (!result) return null;
  const targetLabel = result.target || `${connection.user ? `${connection.user}@` : ''}${connection.host}`;

  const verdict = result.status === 'reachable'
    ? { tone: 'ok', title: 'SSH 连通成功', text: `已成功建立连接。远程主机: ${targetLabel}。` }
    : result.status === 'auth-required'
      ? {
          tone: 'warn',
          title: '拒绝访问 (认证未通过)',
          text: '主机可达，但 SSH 认证失败。请检查当前连接配置的私钥文件路径、私钥内容或密码；使用 SSH Agent 时，请确认当前 AIH Server 运行用户的 ssh-agent 已加载对应密钥。'
        }
      : {
          tone: 'err',
          title: '连接失败',
          text: result.stderr || '网络不可达，请检查 IP 端口是否开通，或者 SSHD 服务是否启动。'
        };

  return (
    <div className={styles.diag}>
      <div className={styles.diagVerdict} data-tone={verdict.tone} role="status">
        <span className={`mhud-status mhud-tone--${verdict.tone}`}>
          <span className={`hud-led hud-led--${verdict.tone}`} aria-hidden="true" />
          {verdict.title}
        </span>
        <p className={styles.note}>{verdict.text}</p>
      </div>
      {result.status === 'reachable' ? (
        <>
          <KeyValue
            rows={[
              { key: 'platform', label: '系统平台', value: result.platform || '未知' },
              { key: 'arch', label: '架构', value: result.arch || '未知' },
              ...DEPENDENCIES.map((dep) => {
                const present = Boolean(result.commands?.[dep.key]);
                const tone = present ? 'ok' as const : dep.key === 'aih' ? 'warn' as const : 'err' as const;
                const text = dep.key === 'aih'
                  ? (present ? '已配置' : '免装模式')
                  : (present ? '已安装' : '未检测到');
                return {
                  key: dep.key,
                  label: dep.label,
                  tone,
                  value: (
                    <span className={`mhud-status mhud-tone--${tone}`}>
                      <span className={`hud-led hud-led--${tone}`} aria-hidden="true" />
                      {text}
                    </span>
                  )
                };
              })
            ]}
          />
          {result.recommendation ? (
            <div className={styles.diagAdvice}>
              <span className="hud-label">诊断建议</span>
              <p className={styles.note}>{result.recommendation}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
