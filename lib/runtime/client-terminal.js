'use strict';

// 公共 facade 保持调用方兼容；每个终端的探测、启动与生命周期实现位于
// client-terminals/<terminal-id>.js，管理器只负责编排和执行。
module.exports = require('./client-terminal-manager');
