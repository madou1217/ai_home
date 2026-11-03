'use strict';

// Agent Session 抽象层的公开入口。
// 消费方只从这里 require：contracts / registry / facade 各取所需，
// 不要直接 require 某个 adapter。

const contracts = require('./contracts');
const { createEventBus } = require('./event-bus');
const { createInteractionRouter } = require('./interaction-router');
const { createAgentSession, TRANSITIONS } = require('./session');
const registry = require('./registry');
const facade = require('./facade');
const sessionStateConsumer = require('./consumers/session-state');

module.exports = {
  ...contracts,
  ...registry,
  createAgentSession,
  createEventBus,
  createInteractionRouter,
  startAgentSession: facade.startAgentSession,
  resolveAdapter: facade.resolveAdapter,
  describeProvider: facade.describeProvider,
  describeAllProviders: facade.describeAllProviders,
  isAdapterImplemented: facade.isAdapterImplemented,
  ADAPTER_MODULES: facade.ADAPTER_MODULES,
  attachSessionStateConsumer: sessionStateConsumer.attachSessionStateConsumer,
  projectSessionStateEvent: sessionStateConsumer.projectEvent,
  TRANSITIONS
};
