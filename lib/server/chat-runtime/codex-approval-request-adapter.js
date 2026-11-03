'use strict';

const {
  array,
  clone,
  codexError,
  nonEmptyStringArray,
  optionalText,
  record,
  requiredText
} = require('./codex-interaction-adapter-support');

function adaptCommandApproval(params) {
  const available = array(params.availableDecisions, 'invalid_codex_command_decisions');
  if (available.length === 0) throw codexError('invalid_codex_command_decisions');
  return approvalProjection(
    requiredItemId(params),
    commandPresentation(params),
    available.map(projectCommandDecision)
  );
}

function projectCommandDecision(nativeDecision, index) {
  const id = `choice-${index}`;
  const basic = {
    accept: ['Allow once', 'accept'],
    acceptForSession: ['Allow for this session', 'accept'],
    decline: ['Decline and continue', 'deny'],
    cancel: ['Decline and cancel turn', 'cancel']
  };
  if (typeof nativeDecision === 'string' && basic[nativeDecision]) {
    const [label, intent] = basic[nativeDecision];
    return projectedChoice(id, label, intent, { decision: nativeDecision });
  }
  return projectStructuredCommandDecision(id, nativeDecision);
}

function projectStructuredCommandDecision(id, nativeDecision) {
  const source = record(nativeDecision, 'unsupported_codex_command_decision');
  if (source.acceptWithExecpolicyAmendment !== undefined) {
    return projectExecPolicyChoice(id, source, nativeDecision);
  }
  if (source.applyNetworkPolicyAmendment !== undefined) {
    return projectNetworkPolicyChoice(id, source, nativeDecision);
  }
  throw codexError('unsupported_codex_command_decision');
}

function projectExecPolicyChoice(id, source, nativeDecision) {
  const value = record(
    source.acceptWithExecpolicyAmendment,
    'invalid_codex_execpolicy_decision'
  );
  const prefix = nonEmptyStringArray(
    value.execpolicy_amendment,
    'invalid_codex_execpolicy_decision'
  );
  return projectedChoice(
    id,
    'Allow and remember command prefix',
    'accept',
    { decision: nativeDecision },
    `Command prefix: ${prefix.join(' ')}`
  );
}

function projectNetworkPolicyChoice(id, source, nativeDecision) {
  const value = record(
    source.applyNetworkPolicyAmendment,
    'invalid_codex_network_policy_decision'
  );
  const amendment = record(
    value.network_policy_amendment,
    'invalid_codex_network_policy_decision'
  );
  const host = requiredText(amendment.host, 'invalid_codex_network_policy_decision');
  if (!['allow', 'deny'].includes(amendment.action)) {
    throw codexError('invalid_codex_network_policy_decision');
  }
  const action = amendment.action === 'deny' ? 'Deny' : 'Allow';
  return projectedChoice(
    id,
    `${action} and remember network policy`,
    amendment.action === 'deny' ? 'deny' : 'accept',
    { decision: nativeDecision },
    `${action} ${host}`
  );
}

function adaptFileApproval(params) {
  return approvalProjection(requiredItemId(params), filePresentation(params), [
    projectedChoice('choice-0', 'Allow once', 'accept', { decision: 'accept' }),
    projectedChoice(
      'choice-1',
      'Allow for this session',
      'accept',
      { decision: 'acceptForSession' }
    ),
    projectedChoice('choice-2', 'Decline and continue', 'deny', { decision: 'decline' }),
    projectedChoice(
      'choice-3',
      'Decline and cancel turn',
      'cancel',
      { decision: 'cancel' }
    )
  ]);
}

function adaptPermissionsApproval(params) {
  const permissions = clone(record(params.permissions, 'invalid_codex_permissions_request'));
  const projected = [
    permissionChoice('choice-0', 'Grant for this turn', permissions, 'turn'),
    permissionChoice(
      'choice-1',
      'Grant for this turn with strict review',
      permissions,
      'turn',
      true
    ),
    permissionChoice('choice-2', 'Grant for this session', permissions, 'session'),
    projectedChoice(
      'choice-3',
      'Do not grant permissions',
      'deny',
      { permissions: {}, scope: 'turn' }
    )
  ];
  return approvalProjection(
    requiredItemId(params),
    permissionsPresentation(params, permissions),
    projected
  );
}

function permissionChoice(id, label, permissions, scope, strictAutoReview) {
  const response = {
    permissions: clone(permissions),
    scope,
    ...(strictAutoReview ? { strictAutoReview: true } : {})
  };
  return projectedChoice(id, label, 'accept', response);
}

function approvalProjection(itemId, presentation, projected) {
  return {
    kind: 'approval',
    itemId,
    payload: { presentation, choices: projected.map(({ choice }) => choice) },
    choiceResponses: new Map(projected.map(({ choice, response }) => [choice.id, response]))
  };
}

function projectedChoice(id, label, intent, response, description) {
  return {
    choice: { id, label, ...(description ? { description } : {}), intent },
    response: clone(response)
  };
}

function commandPresentation(params) {
  return presentation({
    title: 'Run command?',
    description: optionalText(params.reason),
    detail: optionalText(params.command) || 'Command details unavailable',
    annotations: annotations([
      ['Working directory', params.cwd],
      ['Environment', params.environmentId]
    ])
  });
}

function filePresentation(params) {
  return presentation({
    title: 'Apply file changes?',
    description: optionalText(params.reason),
    annotations: annotations([['Requested root', params.grantRoot]])
  });
}

function permissionsPresentation(params, permissions) {
  return presentation({
    title: 'Grant permissions?',
    description: optionalText(params.reason),
    detail: JSON.stringify(permissions, null, 2),
    annotations: annotations([
      ['Working directory', params.cwd],
      ['Environment', params.environmentId]
    ])
  });
}

function presentation(input) {
  const result = { title: input.title };
  for (const key of ['description', 'detail']) {
    if (input[key]) result[key] = input[key];
  }
  if (input.annotations && input.annotations.length > 0) {
    result.annotations = input.annotations;
  }
  return result;
}

function annotations(entries) {
  return entries.flatMap(([label, value]) => {
    const normalized = optionalText(value);
    return normalized ? [{ label, value: normalized }] : [];
  });
}

function requiredItemId(params) {
  return requiredText(params.itemId, 'invalid_codex_interaction_item');
}

module.exports = {
  adaptCommandApproval,
  adaptFileApproval,
  adaptPermissionsApproval
};
