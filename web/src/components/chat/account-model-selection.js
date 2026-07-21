function normalizeModelIds(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const id = String(value || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// 会话框实际"生效模型"：必须始终属于当前账号的可选模型集合。
// 切账号后 selectedModel 可能还残留上一个账号的模型——解析副作用有一帧滞后，且当新账号目录
// 为空(冷启动/该账号尚未被后台探测)时解析副作用会短路(`if (!accountModelIds.length) return`)、
// 不会重置 selectedModel。此时绝不能把旧账号的模型当成"已选中/可发送"展示，否则用户看到的是
// 别的账号的模型、下拉却是空的/禁用的。规则：
//   · selectedModel 在当前账号目录内 → 用它（用户的显式选择/记忆）
//   · 否则退回当前账号第一个可选模型（目录为空即空串，交给 loading/empty 提示兜底）
export function resolveEffectiveSelectedModel(selectedModel, modelIds) {
  const ids = normalizeModelIds(modelIds);
  const current = String(selectedModel || '').trim();
  if (current && ids.includes(current)) return current;
  return ids[0] || '';
}

// aih-server 网关账号的模型列表：走 provider 聚合（catalog.models[provider]）而非账号投影——
// 因为网关池化了该 provider 的全部账号并解析别名，selectableByAccountRef 里并没有 .aih-server 这一键。
export function listAihServerModels(catalog, provider) {
  const p = String(provider || '').trim();
  if (!p) return [];
  const byProvider = catalog && typeof catalog.models === 'object' ? catalog.models : {};
  return normalizeModelIds(byProvider[p]);
}

export function listAccountEnabledModels(catalog, accountRef) {
  const ref = String(accountRef || '').trim();
  if (!ref) return [];

  const byAccountRef = catalog && typeof catalog.selectableByAccountRef === 'object'
    ? catalog.selectableByAccountRef
    : catalog && typeof catalog.byAccountRef === 'object'
      ? catalog.byAccountRef
      : {};
  return normalizeModelIds(byAccountRef[ref]);
}

// 会话级"上次使用模型"记忆：按 provider:id:projectDirName 建 key；draft/无 id 返回空（不读不写）。
export function getSessionModelKey(session) {
  if (!session || session.draft) return '';
  const id = String(session.id || '').trim();
  if (!id) return '';
  const provider = String(session.provider || '').trim();
  const dir = String(session.projectDirName || '').trim();
  return `chat-session-model:${provider}:${id}:${dir}`;
}

// 会话"上次用模型"的**持久真相在服务端**（model_usage_records，跟随 server、可读历史）。
// 这里只保留一个**当前标签页内存缓存**，用于覆盖服务端用量扫描的滞后：用户刚在本会话选/发过的
// 模型立刻记住，切走再回来不会因为还没扫描到而回退成账号默认。不落 localStorage，避免设备本地漂移。
const sessionModelMemory = new Map();

export function rememberSessionModel(session, model) {
  const key = getSessionModelKey(session);
  const value = String(model || '').trim();
  if (key && value) sessionModelMemory.set(key, value);
}

export function recallSessionModel(session) {
  const key = getSessionModelKey(session);
  return key ? (sessionModelMemory.get(key) || '') : '';
}

export function getAccountDefaultModel(catalog, accountRef) {
  const ref = String(accountRef || '').trim();
  if (!ref) return '';
  const defaultByAccountRef = catalog && typeof catalog.defaultByAccountRef === 'object'
    ? catalog.defaultByAccountRef
    : {};
  const modelId = String(defaultByAccountRef[ref] || '').trim();
  if (!modelId) return '';
  return listAccountEnabledModels(catalog, ref).includes(modelId) ? modelId : '';
}
