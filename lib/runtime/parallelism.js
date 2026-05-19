'use strict';

const os = require('node:os');

function getDefaultParallelism(osModule = os) {
  try {
    if (typeof osModule.availableParallelism === 'function') {
      const n = Number(osModule.availableParallelism());
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch (_e) {}

  try {
    const cpus = Array.isArray(osModule.cpus && osModule.cpus()) ? osModule.cpus() : [];
    if (cpus.length > 0) return cpus.length;
  } catch (_e) {}

  return 1;
}

module.exports = {
  getDefaultParallelism
};
