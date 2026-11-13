'use strict';

// 「删除仍留在 Node」的 Provider 登记表。
// 全量 Provider（含 zcode）删除投影已迁入 Go deletionprojection，当前表为空对象；
// Go 守卫测试（TestNodeOnlyDeletionHooksMatchNodeRegistry）仍校验两边保持一致。
const NODE_ONLY_DELETION_HOOKS = Object.freeze({});

module.exports = { NODE_ONLY_DELETION_HOOKS };
