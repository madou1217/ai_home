import type { ChangeEvent } from 'react';
import { providerNames } from '@/components/chat/ProviderIcon';
import DirectoryPickerDialog from '@/features/legacy-chat/DirectoryPickerDialog';
import AccountQuotaResetHistoryModal from '@/features/accounts/AccountQuotaResetHistoryModal';
import { AccountAppInstallModal } from '@/features/accounts/AccountAppInstallModal';
import { AccountAppInstallResultModal } from '@/features/accounts/AccountAppInstallResultModal';
import { AddAccountModal } from '@/features/accounts/AddAccountModal';
import { AuthProgressModal } from '@/features/accounts/AuthProgressModal';
import { CliPickerModal } from '@/features/accounts/CliPickerModal';
import { CodexResetCreditsModal } from '@/features/accounts/CodexResetCreditsModal';
import { EditAccountModal } from '@/features/accounts/EditAccountModal';
import { ImportAccountsModal } from '@/features/accounts/ImportAccountsModal';
import { KimiDesktopLoginModal } from '@/features/accounts/KimiDesktopLoginModal';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import { getAccountRef } from '@/features/accounts/account-model-catalog';
import { IMPORT_FILE_ACCEPT, PASTE_TEMPLATES } from '@/features/accounts/account-import-export';
import type { ImportUploadKind } from '@/features/accounts/account-import-export';
import type { AccountActions } from '@/features/accounts/use-account-actions';

// 目录上传依赖非标准属性 webkitdirectory（Chromium / Safari / Firefox 均支持）。
const FOLDER_INPUT_PROPS = { webkitdirectory: '', directory: '' } as Record<string, string>;

/**
 * 账号页的业务弹窗栈（添加 / 授权进度 / 编辑凭据 / 导入 / 应用安装 / CLI 终端选择 /
 * 服务端目录 / Kimi 桌面托管登录 / Codex 重置额度 / 额度重置历史）。
 * 桌面 Accounts.tsx 与移动端 MobileAccounts 共用；状态全部来自 useAccountActions。
 * 出口设置弹窗（AccountEgressModal）由页面自己渲染。
 */
export default function AccountFlowModals({ actions }: { actions: AccountActions }) {
  const {
    add,
    edit,
    authProgress,
    import: importFlow,
    appInstall,
    cliPicker,
    kimiDesktopLogin,
    codexReset,
    quotaResetHistory
  } = actions.modals;

  const onPickFiles = (kind: ImportUploadKind) => (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    // 清空 value，允许再次选择同一个文件 / 文件夹。
    event.target.value = '';
    void importFlow.onFilesSelected(kind, files);
  };

  const installRecord = appInstall.prompt?.record;
  const installResultRecord = appInstall.result?.prompt.record;

  return (
    <>
      <ImportAccountsModal
        open={importFlow.open}
        importing={importFlow.importing}
        canSubmit={importFlow.canSubmit}
        mode={importFlow.mode}
        fileName={importFlow.fileName}
        pasteTemplate={importFlow.pasteTemplate}
        importText={importFlow.importText}
        onModeChange={importFlow.onModeChange}
        onTemplateChange={importFlow.onTemplateChange}
        onTextChange={importFlow.onTextChange}
        onPickFile={() => importFlow.inputRef.current?.click()}
        onPickFolder={() => importFlow.folderInputRef.current?.click()}
        onFillTemplate={() => importFlow.onTextChange(PASTE_TEMPLATES[importFlow.pasteTemplate].value)}
        onSubmit={importFlow.onSubmit}
        onCancel={importFlow.onCancel}
      />
      <input
        ref={importFlow.inputRef}
        type="file"
        accept={IMPORT_FILE_ACCEPT}
        multiple
        hidden
        onChange={onPickFiles('file')}
      />
      <input
        ref={importFlow.folderInputRef}
        type="file"
        multiple
        hidden
        {...FOLDER_INPUT_PROPS}
        onChange={onPickFiles('folder')}
      />

      <EditAccountModal
        open={edit.open}
        form={edit.form}
        isClaudeCredential={edit.isClaudeCredential}
        effectiveAuthMode={edit.effectiveAuthMode}
        credentialModeChanged={edit.credentialModeChanged}
        onClose={edit.onClose}
        onSubmit={edit.onSubmit}
      />

      <AddAccountModal
        open={add.open}
        form={add.form}
        submitting={add.submitting}
        onSubmit={add.onSubmit}
        onCancel={add.onCancel}
      />

      <AuthProgressModal
        open={authProgress.open}
        job={authProgress.job}
        subjectLabel={authProgress.subjectLabel}
        successClosing={authProgress.successClosing}
        callbackUrl={authProgress.callbackUrl}
        callbackSubmitting={authProgress.callbackSubmitting}
        cliInstallSubmitting={authProgress.cliInstallSubmitting}
        canSubmitCallback={authProgress.canSubmitCallback}
        onClose={authProgress.onClose}
        onCallbackUrlChange={authProgress.onCallbackUrlChange}
        onSubmitBrowserCallback={authProgress.onSubmitBrowserCallback}
        onConfirmCliInstall={authProgress.onConfirmCliInstall}
      />
      <AccountAppInstallModal
        open={Boolean(appInstall.prompt)}
        providerName={installRecord ? (providerNames[installRecord.provider] || installRecord.provider) : ''}
        kind={appInstall.prompt?.kind || 'desktop'}
        message={appInstall.prompt?.message || ''}
        confirmLoading={appInstall.submitting}
        onConfirm={appInstall.onConfirm}
        onCancel={appInstall.onCancel}
      />
      <AccountAppInstallResultModal
        open={Boolean(appInstall.result)}
        providerName={installResultRecord ? (providerNames[installResultRecord.provider] || installResultRecord.provider) : ''}
        accountLabel={installResultRecord ? getAccountPrimaryLabel(installResultRecord) : ''}
        kind={appInstall.result?.prompt.kind || 'desktop'}
        job={appInstall.result?.job || null}
        error={appInstall.result?.error}
        onOpenApp={appInstall.onOpenApp}
        onRetry={appInstall.onRetry}
        onClose={appInstall.onCloseResult}
      />
      <CliPickerModal
        account={cliPicker.account}
        terminals={cliPicker.terminals}
        selectedTerminalId={cliPicker.selectedTerminalId}
        loading={cliPicker.loading}
        workdir={cliPicker.workdir}
        workdirHistory={cliPicker.workdirHistory}
        onTerminalChange={cliPicker.onTerminalChange}
        onWorkdirChange={cliPicker.onWorkdirChange}
        onBrowseWorkdir={cliPicker.directoryPicker.open}
        onClearWorkdirHistory={cliPicker.onClearWorkdirHistory}
        onCancel={cliPicker.onCancel}
        onOpen={cliPicker.onOpen}
      />
      <DirectoryPickerDialog
        open={cliPicker.directoryPicker.visible}
        currentPath={cliPicker.directoryPicker.currentPath}
        parentPath={cliPicker.directoryPicker.parentPath}
        directories={cliPicker.directoryPicker.directories}
        loading={cliPicker.directoryPicker.loading}
        selectedPath={cliPicker.directoryPicker.selectedPath}
        onCancel={cliPicker.directoryPicker.close}
        onConfirm={cliPicker.directoryPicker.confirm}
        onNavigate={cliPicker.directoryPicker.load}
        onSelect={cliPicker.directoryPicker.select}
      />
      <KimiDesktopLoginModal
        open={Boolean(kimiDesktopLogin.request)}
        accountRef={kimiDesktopLogin.request ? getAccountRef(kimiDesktopLogin.request.account) : ''}
        accountLabel={kimiDesktopLogin.request ? getAccountPrimaryLabel(kimiDesktopLogin.request.account) : ''}
        onClose={kimiDesktopLogin.onClose}
        onSuccess={kimiDesktopLogin.onSuccess}
      />
      <CodexResetCreditsModal
        open={Boolean(codexReset.account)}
        account={codexReset.account}
        onClose={codexReset.onClose}
        onAvailableCountChange={codexReset.onAvailableCountChange}
      />
      <AccountQuotaResetHistoryModal
        open={Boolean(quotaResetHistory.account)}
        account={quotaResetHistory.account}
        onClose={quotaResetHistory.onClose}
      />
    </>
  );
}
