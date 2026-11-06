'use strict';

// 「删除仍留在 Node」的 Provider 必须在这里登记**真实的拦截/探测点**。
//
// Go 的 nodeOnlyDeletionReasons
// （internal/adapters/accounts/deletionprojection/spec.go）只写原因，原因本身无法
// 证明 Node 侧真的做了这件事。本表是双侧合同：
//   - Node 测试（test/account-deletion-node-only-hooks.test.js）require 每个导出，
//     并用删除路由实测这些点确实被调用；
//   - Go 守卫（TestNodeOnlyDeletionHooksMatchNodeRegistry）读取本文件，断言 Provider
//     键集合与 nodeOnlyDeletionReasons 完全一致，且每个 hook 的文件存在、导出名在
//     module.exports 里、调用点真的调用了它。
// 任意一侧单独删除 hook 都会让另一侧失败。
//
// 字段：
//   file      —— 定义 hook 的模块（相对仓库根）
//   export    —— 该模块 module.exports 里的函数名
//   callSites —— 删除路径上真正调用它的文件（相对仓库根）
//
// 登记标准：hook 必须位于 handleDeleteAccountRequest 的同步调用链上，且承担 Node
// 才做得的事（进程内状态、本机密钥、Node 独占的 app-state.db）。
const NODE_ONLY_DELETION_HOOKS = Object.freeze({
  agy: Object.freeze([
    // 暖机 LS 池是 agy-warm-ls-pool.js 里的模块级 Map：条目、PID、端口都只存在于
    // Node 进程内存，没有 pid 文件/marker 可供 Go 枚举。删除前必须驱逐并失败关闭，
    // 否则会留下攥着已删凭据的常驻进程。
    Object.freeze({
      file: 'lib/server/webui-account-routes-delete.js',
      export: 'evictAgyWarmWriterBeforeDelete',
      callSites: ['lib/server/webui-account-routes.js']
    })
  ]),
  zcode: Object.freeze([
    // 出口绑定落在 Node 独占的 app-state.db（app_kv account:egress:<ref>），与 Go 的
    // aih.db 不是同一个库；删除必须由 Node 清掉，否则会留下孤儿绑定。
    Object.freeze({
      file: 'lib/account/zcode-egress-binding-store.js',
      export: 'deleteAccountEgressBinding',
      callSites: ['lib/account/account-removal.js']
    }),
    // 桌面协议桥的归属证据（hosts/<pid>.json）只有 Node 能解析；删除前必须探测并
    // 释放持有该账号凭据的桌面实例（影子 App 目录是全机共享的，不能跟着账号删）。
    Object.freeze({
      file: 'lib/runtime/zcode-desktop-bridge-binding.js',
      export: 'resolveZcodeDesktopBridgeBinding',
      callSites: ['lib/server/account-deletion-occupancy.js']
    })
  ])
});

module.exports = { NODE_ONLY_DELETION_HOOKS };
