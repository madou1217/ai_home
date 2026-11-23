import { useState } from 'react';
import { Button, Popover, message } from 'antd';
import { CopyOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { Session } from '@/types';
import styles from './session-continue.module.css';

function copyCommand(command: string) {
  const done = () => message.success('已复制命令');
  const failed = () => message.warning('复制失败，请手动选择命令文本');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(command).then(done, failed);
    return;
  }
  failed();
}

/** 继续会话的两条命令：AIH 命令与 Provider 原生 CLI 命令。 */
export function SessionContinueCommands({ session }: { session: Session }) {
  const hint = session.continue;
  if (!hint) return null;
  return (
    <div className={styles.commands}>
      <div className={styles.row}>
        <span className={styles.label}>AIH</span>
        <code className={styles.code} title={hint.aih}>{hint.aih}</code>
        <Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制 AIH 命令" onClick={() => copyCommand(hint.aih)} />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>原生</span>
        <code className={styles.code} title={hint.native}>{hint.native}</code>
        <Button type="text" size="small" icon={<CopyOutlined />} aria-label="复制原生命令" onClick={() => copyCommand(hint.native)} />
      </div>
      {hint.note ? <div className={styles.note}>{hint.note}</div> : null}
    </div>
  );
}

/** 会话列表行内的入口；没有继续命令时不渲染。 */
export function SessionContinueButton({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  if (!session.continue) return null;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="left"
      title="继续此会话"
      content={<SessionContinueCommands session={session} />}
    >
      <Button
        type="text"
        size="small"
        icon={<InfoCircleOutlined />}
        aria-label="查看继续命令"
        onClick={(event) => event.stopPropagation()}
      />
    </Popover>
  );
}
