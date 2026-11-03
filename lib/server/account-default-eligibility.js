'use strict';

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function evaluateDefaultAccountEligibility(account) {
  if (!account || typeof account !== 'object') {
    return {
      allowed: false,
      code: 'account_unavailable',
      message: '账号状态不可用，不能设为默认账号。'
    };
  }
  if (account.authPending === true) {
    return {
      allowed: false,
      code: 'account_auth_pending',
      message: 'OAuth 授权中的账号不能设为默认账号，请先完成授权。'
    };
  }
  if (account.configured !== true) {
    return {
      allowed: false,
      code: 'account_unconfigured',
      message: '未配置账号不能设为默认账号。'
    };
  }
  if (normalizeStatus(account.status) === 'down') {
    return {
      allowed: false,
      code: 'account_disabled',
      message: '已停用账号不能设为默认账号。'
    };
  }

  const runtimeStatus = normalizeStatus(account.runtimeStatus);
  if (runtimeStatus && runtimeStatus !== 'healthy') {
    return {
      allowed: false,
      code: 'account_runtime_unavailable',
      message: '账号认证或运行状态异常，不能设为默认账号。'
    };
  }

  const schedulableStatus = normalizeStatus(account.schedulableStatus);
  if (schedulableStatus && schedulableStatus !== 'schedulable') {
    return {
      allowed: false,
      code: 'account_unschedulable',
      message: '账号当前不可调度，不能设为默认账号。'
    };
  }

  return { allowed: true, code: '', message: '' };
}

function isDefaultAccountEligible(account) {
  return evaluateDefaultAccountEligibility(account).allowed;
}

module.exports = {
  evaluateDefaultAccountEligibility,
  isDefaultAccountEligible
};
