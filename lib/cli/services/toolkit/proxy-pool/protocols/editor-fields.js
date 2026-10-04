'use strict';

const { SUPPORTED_TRANSPORTS } = require('../proxy-protocol-contract');

const TRANSPORT_LABELS = Object.freeze({ tcp: 'TCP', ws: 'WebSocket', grpc: 'gRPC' });

// 传输层选项由传输契约派生，供协议插件的编辑表单复用。
const TRANSPORT_OPTIONS = Object.freeze([...SUPPORTED_TRANSPORTS].map((value) => Object.freeze({
  label: TRANSPORT_LABELS[value] || value,
  value
})));

module.exports = {
  TRANSPORT_OPTIONS
};
