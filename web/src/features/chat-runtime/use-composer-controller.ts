import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { message as toast } from 'antd';
import { useSessionSelector } from '@/chat-runtime';
import type { SessionProjection } from '@/chat-runtime';
import { canSubmitComposerInput, resolveComposerPolicy } from './composer-policy';
import type { ComposerPolicy } from './composer-policy';
import type { ComposerDelivery } from './session-runtime-actions';
import type { ApprovalMode } from './session-surface-policy';
import type { ComposerProps } from './Composer';
import {
  resolveComposerModelSelection,
  resolveSessionDefaultModel,
  selectLastAssistantModel,
} from './composer-model-policy';
import { useComposerAttachments } from './use-composer-attachments';
import type { PendingComposerAttachment, PendingComposerAttachmentStatus } from './use-composer-attachments';
import {
  clearComposerDraft,
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
  type ComposerDraftIdentity,
} from './composer-draft-store';

export interface ComposerController {
  readonly policy: ComposerPolicy;
  readonly input: string;
  readonly busy: boolean;
  readonly canSend: boolean;
  readonly canAttach: boolean;
  readonly attachments: readonly PendingComposerAttachment[];
  readonly slashMatches: readonly string[];
  readonly delivery?: ComposerDelivery;
  readonly reasoningEffort: string;
  readonly model: string;
  readonly setInput: (value: string) => void;
  readonly addAttachments: (files: readonly File[]) => Promise<void>;
  readonly removeAttachment: (key: string) => void;
  readonly retryAttachment: (key: string) => Promise<void>;
  readonly setAttachmentStatus: (keys: readonly string[], status: PendingComposerAttachmentStatus, error?: string) => void;
  readonly markAttachmentsUploaded: (uploads: readonly { key: string; attachmentId: string }[]) => void;
  readonly setDelivery: (value: ComposerDelivery) => void;
  readonly setReasoningEffort: (value: string) => void;
  readonly selectModel: (value: string) => void;
  readonly send: () => Promise<void>;
  readonly interrupt: () => Promise<void>;
  readonly changeApprovalMode: (mode: ApprovalMode) => Promise<void>;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly draftIdentity: ComposerDraftIdentity;
}

export function useComposerController(props: ComposerProps): ComposerController {
  const view = useComposerViewState(props);
  const commands = useComposerCommands(props, view);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void commands.send();
  }, [commands]);
  return { ...view, ...commands, handleKeyDown };
}

function useComposerViewState(props: ComposerProps) {
  const projection = useSessionSelector(props.store, selectComposerProjection);
  const policy = useMemo(
    () => resolveComposerPolicy(
      projection.state,
      projection.capabilities,
      projection.compacting,
      props.workspaceMode !== 'chat',
      props.workspaceMode !== 'chat',
    ),
    [projection, props.workspaceMode],
  );
  // 草稿只跟会话走：换账号/换 provider 不换槽位（见 composer-draft-store）。
  const draftIdentity = useMemo<ComposerDraftIdentity>(() => ({
    sessionId: projection.sessionId,
    draft: props.draft,
    workspaceMode: props.workspaceMode,
    projectPath: props.projectPath,
  }), [projection.sessionId, props.draft, props.projectPath, props.workspaceMode]);
  const draftKey = composerDraftKey(draftIdentity);
  const hydratedDraftKey = useRef('');
  const [input, setInputState] = useState('');
  const setInput = useCallback((value: string): void => setInputState(value), []);
  useEffect(() => {
    if (hydratedDraftKey.current === draftKey) return;
    hydratedDraftKey.current = draftKey;
    setInputState(readComposerDraft(draftIdentity));
  }, [draftIdentity, draftKey]);
  useEffect(() => {
    if (hydratedDraftKey.current !== draftKey) return;
    const timer = window.setTimeout(() => writeComposerDraft(draftIdentity, input), 180);
    return () => {
      window.clearTimeout(timer);
      writeComposerDraft(draftIdentity, input);
    };
  }, [draftIdentity, draftKey, input]);
  const [requestedDelivery, setDelivery] = useState<ComposerDelivery>(props.workspaceMode === 'chat' ? 'after_turn' : 'turn');
  const [effortChoice, setEffortChoice] = useState<{ sessionId: string; value: string }>();
  const reasoningEffort = effortChoice?.sessionId === projection.sessionId
    ? effortChoice.value : projection.reasoningEffort;
  const setReasoningEffort = useCallback((value: string): void => {
    setEffortChoice({ sessionId: projection.sessionId, value });
  }, [projection.sessionId]);
  const [busy, setBusy] = useState(false);
  const attachments = useComposerAttachments();
  const delivery = policy.deliveries.includes(requestedDelivery)
    ? requestedDelivery
    : policy.deliveries[0];
  const pendingSlash = parseSlash(input.trim(), policy.slashCommands, policy.slashPassthrough);
  const selection = resolveComposerModelSelection(
    props.catalog,
    props.selectedModel,
    reasoningEffort,
  );
  // 会话默认模型按「会话 × 账号」应用：selectedModel 是整页共享状态，切会话时不会重置，
  // 不重新决定就会沿用上一个会话的模型。规则见 resolveSessionDefaultModel；历史异步到达、
  // 最后使用的模型变化时会再应用一次；用户在当前会话手选后不再覆盖，切会话/账号后重新决定。
  const lastUsedModel = useSessionSelector(props.store, selectLastAssistantModel);
  const sessionModelKey = `${projection.sessionId}|${props.accountRef || ''}`;
  const sessionDefaultModel = resolveSessionDefaultModel(props.catalog, lastUsedModel);
  const pickedSessionModelKey = useRef('');
  const appliedSessionModel = useRef('');
  // 已发起、父组件尚未回传的会话默认模型：期间不能让下面的通用回落用旧值覆盖它。
  const pendingSessionModel = useRef('');
  useEffect(() => {
    if (!sessionDefaultModel || pickedSessionModelKey.current === sessionModelKey) return;
    const applied = `${sessionModelKey}|${sessionDefaultModel}`;
    if (appliedSessionModel.current === applied) return;
    appliedSessionModel.current = applied;
    if (sessionDefaultModel !== props.selectedModel) {
      pendingSessionModel.current = sessionDefaultModel;
      props.onModelChange(sessionDefaultModel);
    }
  }, [props.onModelChange, props.selectedModel, sessionDefaultModel, sessionModelKey]);
  useEffect(() => {
    if (pendingSessionModel.current) {
      if (pendingSessionModel.current !== props.selectedModel) return;
      pendingSessionModel.current = '';
    }
    if (selection.model && selection.model !== props.selectedModel) {
      props.onModelChange(selection.model);
    }
  }, [props.onModelChange, props.selectedModel, reasoningEffort, selection]);
  const selectModel = useCallback((model: string): void => {
    const next = resolveComposerModelSelection(props.catalog, model, reasoningEffort);
    if (!next.model) return;
    pickedSessionModelKey.current = sessionModelKey;
    props.onModelChange(next.model);
    setReasoningEffort(next.effort);
  }, [props.catalog, props.onModelChange, reasoningEffort, sessionModelKey, setReasoningEffort]);
  // Attachments may be prepared while a new session is still starting. The
  // initial delivery is `after_turn`, but it becomes a normal turn once the
  // session reaches idle; keep the chip pending across that transition. An
  // already running turn must stay attachment-free for queue/intervention
  // deliveries because those payloads cannot carry attachment IDs.
  const canAttach = !busy && !pendingSlash
    && (delivery === 'turn' || projection.state === 'starting');
  const canSend = Boolean(selection.model)
    && !(pendingSlash && attachments.items.length > 0)
    && (delivery === 'turn' || attachments.items.length === 0)
    && attachments.items.every((item) => item.status === 'ready' || item.status === 'uploaded')
    && canSubmitComposerInput(input, delivery, busy, attachments.items.length);
  return {
    policy, input, setInput, delivery, setDelivery, draftIdentity,
    model: selection.model, reasoningEffort: selection.effort,
    setReasoningEffort, selectModel,
    busy, setBusy, canSend, canAttach, pendingSlash,
    attachments: attachments.items,
    addAttachments: attachments.addFiles,
    removeAttachment: attachments.remove,
    retryAttachment: attachments.retry,
    setAttachmentStatus: attachments.setStatus,
    markAttachmentsUploaded: attachments.markUploaded,
    clearAttachments: attachments.clear,
    slashMatches: slashSuggestions(input, policy.slashCommands),
  };
}

type ComposerViewState = ReturnType<typeof useComposerViewState>;

function useComposerCommands(props: ComposerProps, view: ComposerViewState) {
  const send = useCallback(async (): Promise<void> => {
    if (!view.canSend || !view.delivery) return;
    view.setBusy(true);
    try {
      await dispatchComposerInput(props, view);
      view.setInput('');
      clearComposerDraft(view.draftIdentity);
      view.clearAttachments();
    } catch (error) { toast.error(errorText(error, '命令提交失败')); }
    finally { view.setBusy(false); }
  }, [props, view]);
  const interrupt = useCallback(async (): Promise<void> => {
    try { await props.actions.interrupt(); }
    catch (error) { toast.error(errorText(error, '停止失败')); }
  }, [props.actions]);
  const changeApprovalMode = useCallback(async (mode: ApprovalMode): Promise<void> => {
    try {
      await props.actions.setPolicy('approvalMode', mode);
      props.onApprovalModeChange(mode);
    } catch (error) { toast.error(errorText(error, '审批模式更新失败')); }
  }, [props.actions, props.onApprovalModeChange]);
  return { send, interrupt, changeApprovalMode };
}

async function dispatchComposerInput(props: ComposerProps, view: ComposerViewState): Promise<void> {
  const content = view.input.trim();
  if (view.pendingSlash) {
    await props.actions.executeSlash(view.pendingSlash.name, view.pendingSlash.arguments);
  } else if (view.delivery === 'turn') {
    const pending = view.attachments.filter((attachment) => !attachment.attachmentId);
    const pendingKeys = pending.map(({ key }) => key);
    if (pendingKeys.length > 0) view.setAttachmentStatus(pendingKeys, 'uploading');
    const uploadedByKey = new Map<string, string>();
    try {
      if (pending.length > 0) {
        const uploaded = await props.uploadAttachments(pending.map(({ name, mimeType, dataUrl }) => ({
          name, mimeType, dataUrl,
        })));
        if (uploaded.length !== pending.length || uploaded.some(({ attachmentId }) => !attachmentId)) {
          throw new Error('附件上传结果无效');
        }
        uploaded.forEach(({ attachmentId }, index) => uploadedByKey.set(pending[index].key, attachmentId));
        view.markAttachmentsUploaded(pending.map(({ key }) => ({ key, attachmentId: uploadedByKey.get(key)! })));
      }
      const attachmentIds = view.attachments
        .map((attachment) => attachment.attachmentId || uploadedByKey.get(attachment.key) || '')
        .filter(Boolean);
      await props.actions.submit({
        content,
        attachmentIds,
        model: view.model,
        reasoningEffort: view.reasoningEffort || undefined,
      });
    } catch (error) {
      if (pendingKeys.length > 0 && uploadedByKey.size === 0) {
        view.setAttachmentStatus(pendingKeys, 'failed', errorText(error, '附件上传失败'));
      }
      throw error;
    }
  } else if (view.delivery) await props.actions.deliver(content, view.delivery);
}

function selectComposerProjection(projection: SessionProjection) {
  const context = projection.policy.contextState as { compaction?: { status?: string } } | undefined;
  return {
    sessionId: projection.sessionId,
    state: projection.state,
    capabilities: projection.capabilitySnapshot,
    compacting: context?.compaction?.status === 'running',
    reasoningEffort: typeof projection.policy.reasoningEffort === 'string'
      ? projection.policy.reasoningEffort : '',
  };
}

function slashSuggestions(input: string, commands: readonly string[]): readonly string[] {
  const token = input.trim().replace(/^\//, '');
  return input.trim().startsWith('/') ? commands.filter((command) => command.startsWith(token)) : [];
}

function parseSlash(input: string, commands: readonly string[], allowPassthrough = false) {
  const match = input.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match || (!allowPassthrough && !commands.includes(match[1]))) return null;
  return { name: match[1], arguments: match[2]?.trim() || undefined };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
