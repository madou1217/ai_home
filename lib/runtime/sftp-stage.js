'use strict';

// Caller owns a fresh random filename. Report ownership only after exclusive
// OPEN ACK, and don't publish until both WRITE and CLOSE have succeeded.
async function writeSftpStage(invoke, file, bytes, options = {}) {
  let handle;
  let closeSent = false;
  try {
    handle = await invoke('open', [file, 'wx', options.mode ?? 0o600]);
    options.onOwned?.();
    await invoke('write', [handle, bytes, 0, bytes.length, 0]);
    closeSent = true;
    await invoke('close', [handle]);
  } catch (error) {
    if (handle && !closeSent && typeof error?.code === 'number') {
      try { await invoke('close', [handle]); }
      catch (closeError) {
        // Preserve the transport error if it makes further cleanup uncertain.
        if (typeof closeError?.code !== 'number') {
          closeError.cause = error;
          throw closeError;
        }
      }
    }
    throw error;
  }
}

module.exports = { writeSftpStage };
