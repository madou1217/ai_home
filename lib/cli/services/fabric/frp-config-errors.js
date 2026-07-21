'use strict';

function createFrpError(code, message, details = {}) {
  const error = new Error(message || code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

module.exports = {
  createFrpError
};
