'use strict';

function createInteractionService(options = {}) {
  const {
    readLine
  } = options;

  function askYesNo(query, defaultYes = true) {
    const promptStr = defaultYes ? `${query} [Y/n]: ` : `${query} [y/N]: `;
    const ans = readLine.question(promptStr).trim().toLowerCase();
    if (ans === '') return defaultYes;
    return ans === 'y' || ans === 'yes';
  }

  function stripAnsi(text) {
    return String(text || '').replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  }

  return {
    askYesNo,
    stripAnsi
  };
}

module.exports = {
  createInteractionService
};
