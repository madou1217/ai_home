'use strict';

const {
  applyRequestParameterCapabilityStrategy,
  listOmittedRequestParameterKeys
} = require('./provider-model-capability-registry');

function listProviderProtocolOmittedParameterKeys(provider, protocol, options = {}) {
  return listOmittedRequestParameterKeys({
    ...(options || {}),
    provider,
    protocol
  });
}

function applyProviderProtocolParameterStrategy(payload, options = {}) {
  return applyRequestParameterCapabilityStrategy(payload, options);
}

module.exports = {
  applyProviderProtocolParameterStrategy,
  listProviderProtocolOmittedParameterKeys
};
