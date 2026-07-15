'use strict';

function bufferToText(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data || '');
}

function isAltVClipboardTrigger(data) {
  const text = bufferToText(data);
  const altVPattern = /^\x1b[vV]$/;
  const altVCsiUPattern = /^\x1b\[(?:86|118);3(?:[:;]\d+)*u$/;
  const altVModifyOtherKeysPattern = /^\x1b\[27;3;(?:86|118)(?:;\d+)*~$/;
  return altVPattern.test(text)
    || altVCsiUPattern.test(text)
    || altVModifyOtherKeysPattern.test(text);
}

function isEmptyBracketedPaste(data) {
  return bufferToText(data) === '\x1b[200~\x1b[201~';
}

function extractBracketedPastePayload(data) {
  const text = bufferToText(data);
  if (!text.startsWith('\x1b[200~') || !text.endsWith('\x1b[201~')) return null;
  return text.slice('\x1b[200~'.length, -'\x1b[201~'.length);
}

module.exports = {
  extractBracketedPastePayload,
  isEmptyBracketedPaste,
  isAltVClipboardTrigger
};
