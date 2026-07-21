import {
  CodeOutlined,
  PlusOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import ComposerAccountMenu from '@/components/chat/composer/ComposerAccountMenu';
import ComposerApprovalMenu from '@/components/chat/composer/ComposerApprovalMenu';
import ComposerModelMenu from '@/components/chat/composer/ComposerModelMenu';
import { getAccountIdentityLabel } from '@/utils/account-labels';
import type { ComposerDelivery } from './session-runtime-actions';
import type { ComposerProps } from './Composer';
import type { ComposerController } from './use-composer-controller';
import { canSwitchComposerAccount } from './composer-policy';
import styles from './session-runtime.module.css';

interface Props {
  readonly props: ComposerProps;
  readonly controller: ComposerController;
  readonly onSelectImages: () => void;
}

export default function ComposerToolbar({ props, controller, onSelectImages }: Props) {
  return (
    <div className={styles.composerToolbar}>
      <div className={styles.composerControls}>
        <button
          type="button"
          className={styles.composerToolButton}
          title={controller.canAttach ? '上传图片' : '当前投递方式不支持图片'}
          aria-label="上传图片"
          disabled={!controller.canAttach}
          onClick={onSelectImages}
        >
          <PlusOutlined />
        </button>
        <button
          type="button"
          className={styles.composerToolButton}
          title={props.terminalOpen ? '关闭项目终端' : '打开项目终端'}
          aria-label={props.terminalOpen ? '关闭项目终端' : '打开项目终端'}
          aria-pressed={props.terminalOpen}
          onClick={props.onToggleTerminal}
        >
          <CodeOutlined />
        </button>
        <ComposerAccountMenu
          value={props.accountRef}
          disabled={!canSwitchComposerAccount(controller.policy)}
          options={props.accounts.map((account) => ({
            id: account.accountRef,
            label: getAccountIdentityLabel(account) || account.displayName || account.accountRef,
            badge: account.apiKeyMode ? 'key' : 'OAuth',
          }))}
          onChange={(accountRef) => {
            const account = props.accounts.find((candidate) => candidate.accountRef === accountRef);
            if (account) props.onAccountChange(account);
          }}
        />
        <ComposerApprovalMenu
          value={props.approvalMode}
          onChange={(mode) => void controller.changeApprovalMode(mode)}
        />
        {controller.policy.turnActive && controller.policy.deliveries.length > 0 ? (
          <DeliveryControl controller={controller} />
        ) : null}
      </div>
      <div className={styles.composerActions}>
        <ComposerModelMenu
          models={props.catalog.models}
          model={controller.model}
          effort={controller.reasoningEffort}
          loading={props.catalog.loading}
          error={props.catalog.error}
          onRetry={props.catalog.retry}
          onModelChange={controller.selectModel}
          onEffortChange={controller.setReasoningEffort}
        />
        {controller.policy.canInterrupt ? (
          <button
            type="button"
            className={styles.stopButton}
            aria-label="停止生成"
            onClick={() => void controller.interrupt()}
          >
            <StopOutlined />
          </button>
        ) : (
          <button
            type="button"
            className={styles.sendButton}
            aria-label="发送消息"
            disabled={!controller.canSend || controller.busy}
            onClick={() => void controller.send()}
          >
            <SendOutlined />
          </button>
        )}
      </div>
    </div>
  );
}

function DeliveryControl({ controller }: { readonly controller: ComposerController }) {
  return (
    <select
      className={styles.deliverySelect}
      aria-label="消息投递方式"
      value={controller.delivery}
      onChange={(event) => controller.setDelivery(event.target.value as ComposerDelivery)}
    >
      {controller.policy.deliveries.map((delivery) => (
        <option key={delivery} value={delivery}>{DELIVERY_LABELS[delivery]}</option>
      ))}
    </select>
  );
}

const DELIVERY_LABELS: Readonly<Record<ComposerDelivery, string>> = {
  turn: '发送', steer_current: '立即插话',
  after_tool_boundary: '工具完成后', after_turn: '本轮结束后',
};
