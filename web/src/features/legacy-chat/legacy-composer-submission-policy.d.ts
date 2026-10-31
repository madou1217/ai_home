import type { ChatAccount, Session } from '@/types';
import type { ChatDocumentAttachment } from '@/components/chat/attachment-files';

export interface LegacyComposerSubmissionInput {
  readonly account?: ChatAccount | null;
  readonly session?: Session | null;
  readonly content?: string;
  readonly images?: string[];
  readonly documents?: ChatDocumentAttachment[];
  readonly model?: string;
  readonly projectPath?: string;
  readonly mode?: string;
}

export type LegacyComposerSubmission =
  | {
    readonly ok: true;
    readonly account: ChatAccount;
    readonly session: Session;
    readonly model: string;
    readonly content: string;
    readonly imageList: string[];
    readonly documents?: ChatDocumentAttachment[];
    readonly projectPath: string;
    readonly mode?: string;
  }
  | { readonly ok: false; readonly reason: 'empty_content' | 'account_required' | 'session_required' | 'project_path_required' }
  | { readonly ok: false; readonly reason: 'provider_mismatch'; readonly expectedProvider: Session['provider'] };

export declare function resolveLegacyComposerSubmission(
  input?: LegacyComposerSubmissionInput
): LegacyComposerSubmission;
