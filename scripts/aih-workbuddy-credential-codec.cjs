'use strict';

const fs = require('node:fs');
const { transformWorkbuddyCredentials } = require('../lib/account/workbuddy-credential-codec');

try {
  const input = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('credential_too_large');
  const request = JSON.parse(input);
  // Runs with the selected official Electron distribution, without launching
  // its desktop or writing key material, configuration or credential files.
  const payload = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  const result = transformWorkbuddyCredentials(request.value, request.operation, payload);
  process.stdout.write(JSON.stringify(result));
} catch (_) {
  process.stderr.write('workbuddy_credential_codec_failed\n');
  process.exitCode = 1;
}
