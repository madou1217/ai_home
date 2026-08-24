'use strict';

const { getProxyPoolService } = require('../cli/services/toolkit/proxy-pool/proxy-pool-service');
const {
  executeMihomoInstall,
  planMihomoInstall,
  removeManagedMihomo
} = require('../cli/services/toolkit/proxy-pool/mihomo-core-manager');

const ROUTE_PREFIX = '/v0/webui/toolkit/proxy-pool';
const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;
const pendingInstallPlans = new Map();
const pendingNetworkPlans = new Map();

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function routeError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_JSON_BODY_BYTES) {
        fail(routeError('request_body_too_large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(routeError('invalid_json_body'));
      }
    });
    req.on('error', fail);
  });
}

function errorStatus(errorCode) {
  const code = String(errorCode || '');
  if (code === 'confirmation_required') return 428;
  if (code === 'external_tun_active' || code === 'system_proxy_snapshot_changed' || code === 'tun_snapshot_changed') return 409;
  if (code === 'system_proxy_snapshot_unavailable' || code === 'system_proxy_platform_unsupported' || code === 'network_service_required' || code === 'network_plan_invalid') return 422;
  if (code === 'core_running_install_requires_stop' || code === 'core_running_uninstall_requires_stop') return 409;
  if (code === 'install_plan_invalid' || code === 'core_release_asset_unavailable' || code === 'unsupported_core_platform' || code === 'unsupported_core_architecture') return 422;
  if (code === 'node_not_found' || code === 'subscription_not_found' || code === 'proxy_group_not_found') return 404;
  if (
    code.includes('already_running') ||
    code.includes('in_use') ||
    code === 'proxy_store_busy' ||
    code === 'subscription_changed_during_sync'
  ) return 409;
  if (code === 'mihomo_config_invalid') return 422;
  if (
    code.startsWith('proxy_core_') ||
    code.startsWith('mihomo_') ||
    code.startsWith('subscription_fetch_') ||
    code === 'subscription_http_error' ||
    code === 'subscription_host_resolution_failed'
  ) return 503;
  if (
    code.startsWith('invalid_') ||
    code.startsWith('unsupported_') ||
    code.startsWith('missing_required_') ||
    code.startsWith('subscription_url_') ||
    code === 'no_valid_proxy_nodes_found' ||
    code === 'subscription_response_too_large' ||
    code === 'subscription_redirect_limit_exceeded' ||
    code === 'subscription_redirect_downgrade_blocked'
  ) return 422;
  if (code.endsWith('_required') || code === 'request_body_too_large') return 400;
  return 500;
}

function sendResult(res, result, successStatus = 200) {
  const status = result?.ok === false ? errorStatus(result.error) : successStatus;
  jsonResponse(res, status, result);
}

function sendException(res, error) {
  const code = error.code || error.message || 'internal_error';
  jsonResponse(res, errorStatus(code), {
    ok: false,
    error: code,
    message: error.message && error.message !== code ? error.message : undefined
  });
}

function coreManagerOptions(ctx = {}) {
  const deps = ctx.deps || {};
  return {
    ...ctx,
    ...deps,
    fs: ctx.fs || deps.fs,
    path: ctx.path || deps.path,
    os: ctx.os || deps.os,
    env: ctx.env || deps.env,
    processObj: ctx.processObj || deps.processObj,
    spawnSync: ctx.spawnSync || deps.spawnSync,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
    requestImpl: ctx.requestImpl || deps.requestImpl
  };
}

function publicInstallPlan(plan) {
  return {
    planId: plan.planId,
    version: plan.version,
    platform: plan.platform,
    arch: plan.arch,
    assetName: plan.assetName,
    digest: plan.digest,
    size: plan.size,
    official: plan.official,
    managed: plan.managed
  };
}

function publicNetworkPlanInput(body = {}, kind = 'system-proxy') {
  const input = { action: body.action };
  const keys = kind === 'tun' ? ['tun'] : ['service', 'proxyUrl'];
  for (const key of keys) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  return input;
}

async function handleWebUiProxyPoolRoutes(req, res, method, pathname, ctx = {}) {
  if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return false;
  const service = ctx.proxyPoolService || ctx.deps?.proxyPoolService || getProxyPoolService();

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/core`) {
    try {
      jsonResponse(res, 200, { ok: true, core: service.getCoreStatus() });
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  const coreAction = pathname.match(new RegExp(`^${ROUTE_PREFIX}/core/(start|stop|reload)$`));
  if (method === 'POST' && coreAction) {
    try {
      const actions = {
        start: () => service.startCore(),
        stop: () => service.stopCore(),
        reload: () => service.reloadCore()
      };
      sendResult(res, await actions[coreAction[1]]());
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/core/install/plan`) {
    try {
      const body = await parseJsonBody(req);
      const result = await planMihomoInstall(body, coreManagerOptions(ctx));
      if (result.ok && result.plan) {
        pendingInstallPlans.set(result.plan.planId, result.plan);
        jsonResponse(res, 200, { ok: true, plan: publicInstallPlan(result.plan) });
      } else {
        sendResult(res, result);
      }
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/core/install/execute`) {
    try {
      const body = await parseJsonBody(req);
      const service = ctx.proxyPoolService || getProxyPoolService();
      if (service.getCoreStatus().running) {
        sendResult(res, { ok: false, error: 'core_running_install_requires_stop' });
        return true;
      }
      const plan = pendingInstallPlans.get(String(body.planId || ''));
      if (!plan) {
        sendResult(res, { ok: false, error: 'install_plan_invalid' });
        return true;
      }
      const result = await executeMihomoInstall(plan, {
        ...coreManagerOptions(ctx),
        confirmed: body.confirmed === true
      });
      if (result.ok) {
        pendingInstallPlans.delete(plan.planId);
        service.coreRuntime?.refreshBinary?.(coreManagerOptions(ctx));
        sendResult(res, { ...result, binaryPath: undefined });
      } else {
        sendResult(res, result);
      }
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/core/uninstall`) {
    try {
      const body = await parseJsonBody(req);
      const service = ctx.proxyPoolService || getProxyPoolService();
      if (service.getCoreStatus().running) {
        sendResult(res, { ok: false, error: 'core_running_uninstall_requires_stop' });
        return true;
      }
      const result = removeManagedMihomo({ ...coreManagerOptions(ctx), confirmed: body.confirmed === true });
      if (result.ok) service.coreRuntime?.refreshBinary?.(coreManagerOptions(ctx));
      sendResult(res, result);
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/network/status`) {
    try {
      if (typeof service.getNetworkStatus !== 'function') {
        sendResult(res, { ok: false, error: 'network_status_unavailable' });
      } else {
        sendResult(res, service.getNetworkStatus());
      }
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/network/plan`) {
    try {
      const body = await parseJsonBody(req);
      const kind = body.kind === 'tun' ? 'tun' : 'system-proxy';
      const planInput = publicNetworkPlanInput(body, kind);
      const result = kind === 'tun'
        ? await service.planTunIntegration(planInput)
        : await service.planNetworkIntegration(planInput);
      if (result.ok && result.plan) {
        const planId = result.plan.planId || result.plan.snapshotHash;
        const plan = { ...result.plan, planId, kind };
        pendingNetworkPlans.set(planId, plan);
        sendResult(res, { ...result, plan: { ...plan, previousTun: kind === 'tun' ? undefined : plan.previousTun } });
      } else {
        sendResult(res, result);
      }
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/network/apply`) {
    try {
      const body = await parseJsonBody(req);
      const plan = pendingNetworkPlans.get(String(body.planId || ''));
      if (!plan) {
        sendResult(res, { ok: false, error: 'network_plan_invalid' });
        return true;
      }
      const result = plan.kind === 'tun'
        ? await service.applyTunIntegration(plan, {
          confirmed: body.confirmed === true,
          expectedSnapshotHash: body.expectedSnapshotHash || plan.snapshotHash
        })
        : await service.applyNetworkIntegration(plan, {
          confirmed: body.confirmed === true,
          expectedSnapshotHash: body.expectedSnapshotHash || plan.snapshotHash
        });
      if (result.ok) pendingNetworkPlans.delete(plan.planId || plan.snapshotHash);
      sendResult(res, result);
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/nodes`) {
    try {
      const url = new URL(req.url, 'http://localhost');
      sendResult(res, service.listNodes({
        group: url.searchParams.get('group') || '',
        protocol: url.searchParams.get('protocol') || ''
      }));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/nodes`) {
    try {
      sendResult(res, await service.upsertNode(await parseJsonBody(req)));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/groups`) {
    try {
      sendResult(res, service.listGroups());
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/groups`) {
    try {
      sendResult(res, await service.upsertGroup(await parseJsonBody(req)));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/groups/policy`) {
    try {
      const body = await parseJsonBody(req);
      if (!body.id) throw routeError('proxy_group_id_required');
      sendResult(res, await service.updateGroupPolicy(body.id, {
        strategy: body.strategy,
        failoverStrategy: body.failoverStrategy
      }));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'DELETE' && pathname.startsWith(`${ROUTE_PREFIX}/groups/`)) {
    try {
      const groupId = decodeURIComponent(pathname.slice(`${ROUTE_PREFIX}/groups/`.length));
      sendResult(res, await service.deleteGroup(groupId));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'DELETE' && pathname.startsWith(`${ROUTE_PREFIX}/nodes/`)) {
    try {
      const nodeId = decodeURIComponent(pathname.slice(`${ROUTE_PREFIX}/nodes/`.length));
      sendResult(res, await service.deleteNode(nodeId));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/import`) {
    try {
      const body = await parseJsonBody(req);
      if (typeof body.content !== 'string') throw routeError('proxy_import_content_required');
      sendResult(res, await service.importNodes(body.content, body.subscriptionId || null));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/export`) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const format = url.searchParams.get('format') || 'mihomo';
      const result = service.exportAggregateSubscription(format, {
        group: url.searchParams.get('group') || ''
      });
      if (url.searchParams.get('raw') === 'true' && result.ok) {
        const extension = result.format === 'mihomo' ? 'yaml' : 'txt';
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="ai-home-proxies.${extension}"`,
          'X-AIH-Exported-Node-Count': String(result.exportedNodeCount)
        });
        res.end(result.content);
      } else {
        sendResult(res, result);
      }
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/subscriptions`) {
    try {
      sendResult(res, service.listSubscriptions());
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/subscriptions`) {
    try {
      sendResult(res, await service.upsertSubscription(await parseJsonBody(req)));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/subscriptions/sync`) {
    try {
      const body = await parseJsonBody(req);
      if (!body.id) throw routeError('subscription_id_required');
      sendResult(res, await service.syncSubscription(body.id, {
        storageOnly: body.storageOnly === true
      }));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'DELETE' && pathname.startsWith(`${ROUTE_PREFIX}/subscriptions/`)) {
    try {
      const subscriptionId = decodeURIComponent(pathname.slice(`${ROUTE_PREFIX}/subscriptions/`.length));
      sendResult(res, await service.deleteSubscription(subscriptionId));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/ping`) {
    try {
      const body = await parseJsonBody(req);
      const result = body.nodeId
        ? await service.pingNode(body.nodeId)
        : await service.pingAllNodes(body.filter || {});
      sendResult(res, result);
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/routing`) {
    try {
      sendResult(res, service.getRouting());
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/routing`) {
    try {
      sendResult(res, await service.updateRouting(await parseJsonBody(req)));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'GET' && pathname === `${ROUTE_PREFIX}/dedicated-ports`) {
    try {
      sendResult(res, service.getDedicatedPorts());
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  if (method === 'POST' && pathname === `${ROUTE_PREFIX}/dedicated-ports/toggle`) {
    try {
      const body = await parseJsonBody(req);
      sendResult(res, await service.toggleDedicatedPort(
        body.nodeId,
        Boolean(body.enabled),
        body.requestedPort ?? null
      ));
    } catch (error) {
      sendException(res, error);
    }
    return true;
  }

  return false;
}

module.exports = {
  MAX_JSON_BODY_BYTES,
  errorStatus,
  handleWebUiProxyPoolRoutes,
  parseJsonBody
};
