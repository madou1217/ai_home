'use strict';
const { listExternalHarnesses } = require('../harness/catalog');

// External agent harnesses own resources but are not gateway account providers.
const hosts = new Map(listExternalHarnesses().filter(row => row.pluginHostId).map(row => [row.pluginHostId, row]));
function getHostResourceCapability(host, resource) {
  return hosts.get(host)?.nativeResources?.[resource] || { state: 'unsupported', reason: 'host_resource_adapter_not_registered' };
}
module.exports = { getHostResourceCapability };
