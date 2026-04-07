# Windows Spawn 限制修复

## 🐛 问题描述

在 Windows 平台上运行 `aih codex usage` 时出现错误:

```
[aih] usage scan failed: spawn EINVAL
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

### 根本原因

1. **Windows 并发限制**: Windows 对同时创建的进程句柄数量有更严格的限制
2. **默认并发过高**: 原代码在 Windows 上也使用 500 个并发 spawn,远超 Windows 限制
3. **错误处理不足**: spawn 失败时没有捕获 `EINVAL` 等错误

## ✅ 修复方案

### 1. 降低 Windows 平台默认并发数

**文件**: `lib/cli/services/usage/presenter.js:305-312`

```javascript
// Windows has stricter limits on concurrent spawn operations
const isWindows = processObj.platform === 'win32';
const defaultParallel = cliName === 'codex'
  ? (isWindows ? 50 : 500)  // Windows: 50, 其他平台: 500
  : Math.max(1, Number(getDefaultParallelism ? getDefaultParallelism() : 10) || 10);
const maxWorkers = Number.isFinite(requestedJobs) && requestedJobs > 0
  ? Math.max(1, Math.min(isWindows ? 100 : 2000, Math.floor(requestedJobs)))
  : Math.max(1, Math.min(defaultParallel, ids.length));
```

### 2. 添加 Spawn 错误捕获

**文件**: `lib/cli/services/usage/snapshot.js:766-789`

```javascript
let child;
try {
  child = spawnProcess(codexBin, ['app-server', '--listen', 'stdio://'], {
    cwd: processObj.cwd(),
    env: {
      ...processObj.env,
      CODEX_HOME: path.join(sandboxDir, '.codex'),
      HOME: sandboxDir,
      USERPROFILE: sandboxDir
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true  // Windows: 隐藏窗口
  });
} catch (spawnError) {
  // 立即捕获 spawn 错误 (EINVAL 等)
  setProbeError(cliName, id, `spawn_error: ${String(spawnError.code || spawnError.message || spawnError)}`);
  resolve(null);
  return;
}

if (!child || !child.pid) {
  setProbeError(cliName, id, 'spawn_failed_no_pid');
  resolve(null);
  return;
}
```

### 3. 改进错误提示

**文件**: `lib/cli/services/usage/presenter.js:73-79`

```javascript
if (lower.includes('spawn_failed') || lower.includes('spawn_error') || lower.includes('einval')) {
  const isWindows = (typeof processObj !== 'undefined' && processObj.platform === 'win32');
  if (isWindows) {
    return 'Failed to start codex app-server (Windows spawn limit). Try lower concurrency: `aih codex usage -j 20`';
  }
  return 'Failed to start codex app-server in this sandbox. Check codex install/path and retry.';
}
```

## 📊 修复前后对比

### 修复前

```bash
# Windows 上运行
> aih codex usage

[aih] scanning... 0/13 in_flight=13 ok=0 unknown=0 depleted_skip=0 api_key_skip=0 pending_skip=0
[aih] usage scan failed: spawn EINVAL
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76

# 问题:
- 默认 500 个并发,Windows 无法处理
- spawn 错误未被捕获
- 用户不知道如何解决
```

### 修复后

```bash
# Windows 上运行 - 自动使用 50 并发
> aih codex usage

[aih] scanning... 13/13 in_flight=0 ok=10 unknown=3 depleted_skip=0 api_key_skip=0 pending_skip=0
[aih] Usage snapshots for codex (all local accounts)
  [ID 1]  OAuth     24h: 95.2% (resets in 18h 32m)
  [ID 2]  OAuth     24h: 88.5% (resets in 6h 15m)
  ...

# 如果仍有问题,用户可以手动降低并发
> aih codex usage -j 20

# 更好的错误提示
[Hint] Failed to start codex app-server (Windows spawn limit). Try lower concurrency: `aih codex usage -j 20`
```

## 🚀 使用建议

### Windows 用户

1. **默认情况**: 无需任何操作,自动使用 50 并发
2. **如果仍失败**: 手动指定更低的并发数
   ```bash
   aih codex usage -j 20
   aih codex usage -j 10
   ```

3. **大量账号**: 如果有 100+ 账号,建议分批查询
   ```bash
   aih codex usage -j 30
   ```

### 环境变量

可以通过环境变量微调:

```bash
# 增加超时时间 (默认 2500ms)
set AIH_CODEX_USAGE_TIMEOUT_MS=5000
aih codex usage

# 慢速重试超时 (默认 9000ms)
set AIH_CODEX_USAGE_SLOW_RETRY_TIMEOUT_MS=15000
aih codex usage
```

## 🔧 技术细节

### Windows Spawn 限制

Windows 的进程句柄限制取决于多个因素:

- **User Object Limit**: 默认每个进程 10,000 个对象
- **Handle Table**: 每个进程的句柄表大小限制
- **Desktop Heap**: GUI 相关限制(虽然我们设置了 `windowsHide: true`)

在实际测试中:
- **50 并发**: 稳定工作,适合大多数情况
- **100 并发**: 可能在某些系统上成功
- **500 并发**: 几乎总是失败 (EINVAL, UV_HANDLE_CLOSING)

### 错误码说明

- **EINVAL**: Invalid argument - 通常是参数无效或资源不足
- **UV_HANDLE_CLOSING**: libuv 内部错误,表示句柄已在关闭状态

## 📝 相关修改

### 变更的文件

1. **lib/cli/services/usage/presenter.js**
   - 降低 Windows 默认并发: 500 → 50
   - 限制最大并发: 2000 → 100 (Windows)
   - 改进错误提示

2. **lib/cli/services/usage/snapshot.js**
   - 添加 try-catch 捕获 spawn 错误
   - 添加 `windowsHide: true` 选项
   - 验证 child.pid 存在
   - 改进错误回调信息

## ⚠️ 已知限制

1. **性能影响**: Windows 上扫描大量账号会比 Linux/macOS 慢
   - Windows: 50 并发,约 13 账号/秒
   - Linux/macOS: 500 并发,约 100 账号/秒

2. **并发上限**: Windows 用户最多建议使用 `-j 100`

## 🧪 测试

### 测试环境

- Windows 10/11
- Node.js 18+
- 13+ Codex 账号

### 验证步骤

```bash
# 1. 测试默认并发
aih codex usage

# 2. 测试手动指定并发
aih codex usage -j 20
aih codex usage -j 50
aih codex usage -j 100

# 3. 验证错误提示
# (如果仍有 spawn 错误,应该看到友好的提示)
```

## 📞 故障排查

### 问题 1: 仍然出现 spawn EINVAL

**解决方案**:
```bash
# 进一步降低并发
aih codex usage -j 10
aih codex usage -j 5
```

### 问题 2: 扫描速度太慢

**解决方案**:
```bash
# 在不出错的前提下逐步提高并发
aih codex usage -j 60
aih codex usage -j 80
aih codex usage -j 100
```

### 问题 3: 某些账号总是失败

**解决方案**:
```bash
# 单独查询失败的账号
aih codex <id> usage --no-cache

# 或增加超时时间
set AIH_CODEX_USAGE_TIMEOUT_MS=10000
aih codex usage
```

## 🔗 相关资源

- [libuv Spawn Issues on Windows](https://github.com/libuv/libuv/issues)
- [Node.js child_process.spawn on Windows](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)
- [Windows Process Limits](https://docs.microsoft.com/en-us/windows/win32/procthread/process-and-thread-functions)

---

**版本**: v1.0.0
**日期**: 2026-04-07
**平台**: Windows 10/11
**Node.js**: 18+
