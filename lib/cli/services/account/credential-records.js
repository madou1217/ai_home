'use strict';

const {
  listAccountCredentialRecords
} = require('../../../server/account-credential-store');
const {
  listCliAccountRefRecords
} = require('../../../server/account-ref-store');

function listCliAccountCredentialRecords(fs, aiHomeDir, provider = '') {
  const credentialsByRef = new Map(
    listAccountCredentialRecords(fs, aiHomeDir, provider)
      .map((record) => [record.accountRef, record])
  );

  return listCliAccountRefRecords(fs, aiHomeDir, provider, { bestEffort: true })
    .map((alias) => {
      const credential = credentialsByRef.get(alias.accountRef);
      return credential
        ? { ...credential, cliAccountId: alias.cliAccountId }
        : null;
    })
    .filter(Boolean);
}

module.exports = {
  listCliAccountCredentialRecords
};
