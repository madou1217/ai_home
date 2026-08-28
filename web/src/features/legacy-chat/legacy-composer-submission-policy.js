export function resolveLegacyComposerSubmission(input = {}) {
  const content = String(input.content || '').trim();
  if (!content) return { ok: false, reason: 'empty_content' };

  const account = input.account || null;
  if (!account) return { ok: false, reason: 'account_required' };

  const session = input.session || null;
  if (!session) return { ok: false, reason: 'session_required' };
  if (!session.draft && account.provider !== session.provider) {
    return {
      ok: false,
      reason: 'provider_mismatch',
      expectedProvider: session.provider,
    };
  }

  const projectPath = String(input.projectPath || session.projectPath || '').trim();
  const isPureChat = session.mode === 'chat' || (session.draft && input.mode === 'chat') || input.mode === 'chat';
  if (!projectPath && !isPureChat) return { ok: false, reason: 'project_path_required' };

  return {
    ok: true,
    account,
    session,
    model: String(input.model || '').trim(),
    content,
    imageList: Array.isArray(input.images) ? input.images.slice() : [],
    projectPath: projectPath || '',
    ...(isPureChat ? { mode: 'chat' } : (input.mode ? { mode: input.mode } : {})),
  };
}
