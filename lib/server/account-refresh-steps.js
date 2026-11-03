'use strict';

// 账号刷新的**阶段编排器**：把「刷新一个账号」拆成互相独立的步骤，各自异步、
// 各自捕获错误，任一步失败不影响其它步。
//
// 为什么需要它（2026-10-24 真机事故）：
//   原实现是一个线性 async 函数，`await ensureUsageSnapshotAsync(...)` 是**裸 await**。
//   用量探测一抛错（例如 zcode 的 3001），后面的运行时重载、记录重建全都不执行，
//   整个刷新被标记失败 —— 而模型/运行时其实和用量毫无关系，本该照常刷新。
//   用户的诉求原话：「并行请求或者各自异步请求，其中一个报错不能影响其他的」。
//
// 设计：
//   * 每个步骤是 `{ id, run(ctx), critical?, dependsOn?, enabled? }`，注册进表。
//   * 无依赖的步骤**并发**执行；需要顺序的声明 `dependsOn`。
//   * 每步单独 try/catch，结果记进 `report.steps`，失败只影响该步的 `ok`。
//   * `critical` 步骤失败才让整体算失败；非 critical 失败只记录。
//   * 编排器不认识任何 provider 名 —— 新增刷新面 = 注册一个步骤，不改这里。

function normalizeStep(step) {
  const id = String(step && step.id || '').trim();
  if (!id) throw new Error('refresh_step_id_missing');
  if (typeof step.run !== 'function') throw new Error(`refresh_step_run_missing:${id}`);
  return {
    id,
    label: String(step.label || id).trim(),
    run: step.run,
    // 默认不阻塞整体成败：单个面失败是「该面没刷到」，不是「刷新失败」。
    critical: step.critical === true,
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter(Boolean).map(String) : [],
    enabled: step.enabled !== false
  };
}

function buildStepRegistry(steps) {
  const list = (Array.isArray(steps) ? steps : []).map(normalizeStep);
  const byId = new Map(list.map((step) => [step.id, step]));
  for (const step of list) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) throw new Error(`refresh_step_dependency_missing:${step.id}->${dep}`);
    }
  }
  return { list, byId };
}

/**
 * 执行一批刷新步骤。
 * 返回 `{ ok, steps, failed, criticalFailed }`：
 *   ok             —— 所有 critical 步骤成功（非 critical 失败不影响）
 *   steps[id]      —— { ok, error, durationMs, value }
 *   failed         —— 失败的步骤 id 列表（含非 critical）
 *   criticalFailed —— 失败的 critical 步骤 id 列表
 */
async function runRefreshSteps(registry, ctx, options = {}) {
  const onStepDone = typeof options.onStepDone === 'function' ? options.onStepDone : null;
  const results = new Map();
  const pending = new Map(registry.list.filter((step) => step.enabled).map((step) => [step.id, step]));

  async function executeStep(step) {
    const startedAt = Date.now();
    try {
      const value = await step.run(ctx);
      const entry = { ok: true, error: '', durationMs: Date.now() - startedAt, value };
      results.set(step.id, entry);
      if (onStepDone) onStepDone(step, entry);
      return entry;
    } catch (error) {
      const entry = {
        ok: false,
        error: String((error && error.message) || error || 'unknown').slice(0, 300),
        durationMs: Date.now() - startedAt,
        value: null
      };
      results.set(step.id, entry);
      if (onStepDone) onStepDone(step, entry);
      return entry;
    }
  }

  // 逐轮推进：每轮挑出「依赖已全部完成」的步骤并发执行。
  while (pending.size > 0) {
    const ready = [];
    for (const step of pending.values()) {
      if (step.dependsOn.every((dep) => results.has(dep) || !registry.byId.has(dep))) ready.push(step);
    }
    if (ready.length === 0) {
      // 依赖成环或依赖了被 enabled:false 跳过的步骤：标为未解析，避免死循环。
      for (const step of pending.values()) {
        results.set(step.id, {
          ok: false,
          error: `refresh_step_dependency_unresolved:${step.dependsOn.join(',')}`,
          durationMs: 0,
          value: null
        });
        pending.delete(step.id);
      }
      break;
    }
    for (const step of ready) pending.delete(step.id);
    // 同一轮内互不依赖 —— 并发跑，单个失败不影响同轮其它步骤。
    await Promise.all(ready.map((step) => executeStep(step)));
  }

  const failed = [];
  const criticalFailed = [];
  for (const step of registry.list) {
    const entry = results.get(step.id);
    if (!entry || entry.ok) continue;
    failed.push(step.id);
    if (step.critical) criticalFailed.push(step.id);
  }
  return {
    ok: criticalFailed.length === 0,
    steps: Object.fromEntries(results),
    failed,
    criticalFailed
  };
}

module.exports = {
  normalizeStep,
  buildStepRegistry,
  runRefreshSteps
};
