'use strict';
function mcpError(code) { return Object.assign(new Error(code), { code }); }
function requireMcp(condition, code) { if (!condition) throw mcpError(code); }
module.exports = { mcpError, requireMcp };
