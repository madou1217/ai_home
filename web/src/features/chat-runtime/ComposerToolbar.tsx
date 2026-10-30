import {
  CodeOutlined,
  PlusOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import ComposerAccountMenu from '@/components/chat/composer/ComposerAccountMenu';
import ComposerApprovalMenu from '@/components/chat/composer/ComposerApprovalMenu';
import ComposerModelMenu from '@/components/chat/composer/ComposerModelMenu';
import PromptPresetsCapsule from '@/components/chat/PromptPresetsCapsule';
import { chatAccountIdentity, isAihServerAccount } from '@/components/chat/aih-server-account';
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

/**
 * 当前目标是不是 OpenCode 目录 —— 决定模型菜单是否显示 免费/Zen/Go 分组与芯片。
 *
 * 必须按**选中的目标**判断，不能按模型列表内容：aih-server 目标拿到的是全量网关目录，
 * 里面必然含 opencode 模型，按内容判断会给它套上 OpenCode 专属分组，看起来像
 * 「选了 aih-server 却全是 opencode 模型」（2026-10-21 真机反馈）。
 *
 * aih-server 是跨 provider 目标，一律用单一「全部模型」分组。
 */
function resolveOpenCodeCatalogTarget(
  accounts: ComposerProps['accounts'],
  accountRef: string,
): boolean {
  const selected = accounts.find((account) => chatAccountIdentity(account) === accountRef);
  if (!selected || isAihServerAccount(selected)) return false;
  return selected.provider === 'opencode';
}

export default function ComposerToolbar({ props, controller, onSelectImages }: Props) {
  return (
    <div className={styles.composerToolbar}>
      <div className={styles.composerTools}>
        <button
          type="button"
          className={styles.composerToolButton}
          title={controller.canAttach ? '上传文件' : '当前投递方式不支持附件'}
          aria-label="上传文件"
          disabled={!controller.canAttach}
          onClick={onSelectImages}
        >
          <PlusOutlined />
        </button>
        {props.workspaceMode !== 'chat' ? <button
          type="button"
          className={styles.composerToolButton}
          title="打开项目终端"
          aria-label="打开项目终端"
          onClick={props.onToggleTerminal}
        >
          <CodeOutlined />
        </button> : null}
        <PromptPresetsCapsule compact onSelect={(template) => controller.setInput(template)} />
      </div>
      <div className={styles.composerTarget} aria-label="运行目标">
        <ComposerAccountMenu
          value={props.accountRef}
          disabled={!canSwitchComposerAccount(controller.policy)}
          grouped={props.workspaceMode === 'chat'}
          selectionHint={props.workspaceMode === 'chat' ? '切换后新建会话' : undefined}
          options={props.accounts.map((account) => ({
            id: chatAccountIdentity(account),
            provider: account.provider,
            label: getAccountIdentityLabel(account) || account.displayName || chatAccountIdentity(account),
            // 网关目标不是账号：用 Gateway 标记与真实凭据（API Key / OAuth）区分。
            badge: isAihServerAccount(account) ? 'Gateway' : (account.apiKeyMode ? 'API Key' : 'OAuth'),
          }))}
          onChange={(identity) => {
            const account = props.accounts.find((candidate) => chatAccountIdentity(candidate) === identity);
            if (account) props.onAccountChange(account);
          }}
        />
        {props.workspaceMode !== 'chat' ? <ComposerApprovalMenu
          value={props.approvalMode}
          onChange={(mode) => void controller.changeApprovalMode(mode)}
        /> : null}
        <ComposerModelMenu
          grouped={props.workspaceMode === 'chat'}
          openCodeCatalog={resolveOpenCodeCatalogTarget(props.accounts, props.accountRef)}
          models={props.catalog.models}
          model={controller.model}
          effort={controller.reasoningEffort}
          loading={props.catalog.loading}
          error={props.catalog.error}
          onRetry={props.catalog.retry}
          onModelChange={controller.selectModel}
          onEffortChange={controller.setReasoningEffort}
        />
      </div>
      <div className={styles.composerActions}>
        {controller.policy.turnActive && controller.policy.deliveries.length > 0 ? (
          <DeliveryControl controller={controller} />
        ) : null}
        {controller.policy.canInterrupt ? (
          <button
            type="button"
            className={styles.stopButton}
            aria-label="停止生成"
            onClick={() => void controller.interrupt()}
          >
            <StopOutlined />
          </button>
        ) : null}
        {!controller.policy.canInterrupt || controller.canSend ? (
          <button
            type="button"
            className={styles.sendButton}
            aria-label={controller.policy.turnActive ? '发送补充消息' : '发送消息'}
            disabled={!controller.canSend || controller.busy}
            onClick={() => void controller.send()}
          >
            <SendOutlined />
          </button>
        ) : null}
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
