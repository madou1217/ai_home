'use strict';

const { recoverableReplace } = require('./sftp-replace-transaction');

// Adapter for ssh2's OpenSSH extension. This is not a delete-then-rename
// emulation: inability to replace atomically must never destroy the old file.
function callSftp(sftp, method, args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

function unsupportedRename(error) {
  const remoteStatus = typeof error?.code === 'number' && Number.isFinite(error.code);
  return remoteStatus ? error.code === 8
    : error?.code === undefined && error?.message === 'Server does not support this extended request';
}

async function replaceSftpFile(sftp, temporary, target, invoke = (method, args) => callSftp(sftp, method, args)) {
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      await invoke('ext_openssh_rename', [temporary, target]);
      return;
    } catch (error) {
      // ssh2 throws this exact local capability error before sending a packet.
      // A remote permission/generic failure is NOT evidence of no extension.
      if (!unsupportedRename(error)) throw error;
    }
  }
  // A per-target claim covers creation too: it cannot bypass another AIH
  // transaction while that transaction temporarily has the destination moved.
  await recoverableReplace(temporary, target, invoke);
}

module.exports = { replaceSftpFile, unsupportedRename };
