'use strict';

const values = require('./contract-values');
const normalizers = require('./contract-normalizers');

module.exports = {
  ...values,
  ...normalizers
};
