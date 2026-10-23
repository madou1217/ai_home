import React from 'react';
import { Modal } from 'antd';

// 删除账号被「占用」时的统一交互。
//
// 后端删除是 fail-closed 的：账号还有会话在跑（运行中的会话 / tmux 挂起的持久会话）
// 就拒绝删除，并如实返回占用者清单（error=account_runtime_active + occupants[]）。
// 这不是失败，而是「需要用户决定」：这里把占用者列给用户看，确认后带 force 重发，
// 由后端终止它们再删。
//
// 两个账号页（正式页与 Go 预览页）共用这一段，避免各写一份强杀逻辑。

export type AccountDeletionOccupant = {
  kind?: string;
  label?: string;
  runId?: string;
  sessionId?: string;
  session?: string;
  detail?: string;
};

/** 后端 409 载荷是否为「被占用」。 */
export function isAccountOccupiedError(data: any): boolean {
  return data?.error === 'account_runtime_active';
}

/** 占用者 -> 一行可读文案。只做展示映射，不判断 provider。 */
export function describeDeletionOccupant(occupant: AccountDeletionOccupant): string {
  const label = String(occupant?.label || '').trim() || '占用进程';
  const detail = String(occupant?.sessionId || occupant?.session || occupant?.detail || '').trim();
  return detail ? `${label}：${detail}` : label;
}

/**
 * 弹出「账号正在被占用」确认框。用户确认后调用 onConfirm，由调用方带 force 重发删除。
 * 返回 Modal.confirm 的实例，便于调用方（如单测）驱动。
 */
export function confirmOccupiedAccountDeletion(options: {
  data: any;
  onConfirm: () => void;
}) {
  const { data, onConfirm } = options;
  const occupants: AccountDeletionOccupant[] = Array.isArray(data?.occupants) ? data.occupants : [];
  return Modal.confirm({
    title: '账号正在被占用',
    width: 480,
    content: (
      <div>
        <div>{data?.message || '该账号仍有会话在运行。'}</div>
        {occupants.length > 0 ? (
          <ul style={{ margin: '8px 0 0', paddingInlineStart: 20 }}>
            {occupants.map((occupant, index) => (
              <li key={`${occupant?.kind || 'occupant'}-${index}`}>{describeDeletionOccupant(occupant)}</li>
            ))}
          </ul>
        ) : null}
        <div style={{ marginTop: 8 }}>继续删除将终止以上会话。</div>
      </div>
    ),
    okText: '终止并删除',
    cancelText: '取消',
    okButtonProps: { danger: true },
    onOk: onConfirm
  });
}
