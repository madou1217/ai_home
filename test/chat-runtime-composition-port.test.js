'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

// 聊天装配的推理端口是**硬依赖**：relay 轮次没有第二条执行路径，缺端口必须在
// 装配期失败，而不是等第一轮对话才报错。这条守卫防止有人为了旧脚本/旧测试
// 把端口改回可选，导致生产环境悄悄少一条推理路径。
test('chat 装配缺 chatInference 时启动即失败', () => {
  const { createChatRuntimeComposition } = require('../lib/server/chat-runtime-composition');
  assert.throws(
    () => createChatRuntimeComposition({}),
    (error) => error && error.message === 'chat_inference_port_required'
  );
});
