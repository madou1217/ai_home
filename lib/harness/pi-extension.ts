import { statSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// AIH 生成的 models.json 会在账号/模型目录变化时整体重写。Pi 默认只在启动时
// 读取它，所以这里监听文件变更并调用 modelRegistry.refresh，让 /model 菜单
// 无需重启 TUI 就能看到新模型（与 aih WebUI 的模型目录保持同一份事实）。
const MODELS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'models.json');
const POLL_INTERVAL_MS = 2000;
const DEBOUNCE_MS = 150;

export default function (pi) {
  let registry = null;
  let watcher = null;
  let pollTimer = null;
  let debounceTimer = null;
  let lastMtime = 0;
  let refreshing = false;
  let stopped = true;

  function readMtime() {
    try {
      return statSync(MODELS_PATH).mtimeMs;
    } catch (_error) {
      return 0;
    }
  }

  async function refreshModels() {
    if (stopped || refreshing || !registry || typeof registry.refresh !== 'function') return;
    refreshing = true;
    try {
      await registry.refresh({ providers: ['aih'], allowNetwork: false });
    } catch (_error) {
      // 文件正在被原子替换时 refresh 可能读到一半；下一轮轮询会重试。
    } finally {
      refreshing = false;
    }
  }

  function checkForChanges() {
    const mtime = readMtime();
    if (!mtime || mtime === lastMtime) return;
    lastMtime = mtime;
    void refreshModels();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    lastMtime = readMtime();
    try {
      watcher = watch(dirname(MODELS_PATH), { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== 'models.json') return;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkForChanges, DEBOUNCE_MS);
      });
    } catch (_error) {
      watcher = null;
    }
    pollTimer = setInterval(checkForChanges, POLL_INTERVAL_MS);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  function stop() {
    stopped = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
    if (watcher) {
      try { watcher.close(); } catch (_error) {}
      watcher = null;
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    registry = ctx && ctx.modelRegistry ? ctx.modelRegistry : null;
    start();
  });

  pi.on('session_shutdown', async () => {
    stop();
  });
}
