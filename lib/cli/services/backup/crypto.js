'use strict';

function createBackupCryptoService(options = {}) {
  const {
    fs,
    path,
    crypto,
    spawnSync,
    execSync,
    commandExists,
    askYesNo,
    processObj,
    hostHomeDir,
    exportMagic,
    exportVersion,
    ageSshKeyTypes
  } = options;
  const PASSWORD_FILE_MAGIC = Buffer.from('AIH-PWPKG-V1', 'utf8');
  const PASSWORD_FILE_SALT_LEN = 16;
  const PASSWORD_FILE_IV_LEN = 12;
  const PASSWORD_FILE_TAG_LEN = 16;
  const PASSWORD_FILE_HEADER_LEN = PASSWORD_FILE_MAGIC.length + PASSWORD_FILE_SALT_LEN + PASSWORD_FILE_IV_LEN;

  function getSshKeys() {
    const sshDir = path.join(hostHomeDir, '.ssh');
    if (!fs.existsSync(sshDir)) return [];
    return fs.readdirSync(sshDir).filter((f) => f.startsWith('id_') && !f.endsWith('.pub'));
  }

  function getLikelyRsaSshPrivateKeys() {
    return getSshKeys().filter((name) => {
      const lower = name.toLowerCase();
      if (lower.endsWith('.pub')) return false;
      if (lower.includes('ed25519') || lower.includes('ecdsa') || lower.includes('dsa')) return false;
      try {
        const content = fs.readFileSync(path.join(hostHomeDir, '.ssh', name), 'utf8');
        return /BEGIN (RSA|OPENSSH) PRIVATE KEY/.test(content);
      } catch (_error) {
        return false;
      }
    });
  }

  function hasAgeBinary() {
    const result = spawnSync('age', ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  }

  function getAgeInstallHints() {
    if (processObj.platform === 'darwin') {
      if (commandExists('brew')) {
        return {
          platform: 'macOS',
          command: 'brew install age',
          hint: ''
        };
      }
      return {
        platform: 'macOS',
        command: '',
        hint: 'Homebrew not found. Install Homebrew first, then run: brew install age'
      };
    }
    if (processObj.platform === 'win32') {
      if (commandExists('winget')) {
        return {
          platform: 'Windows',
          command: 'winget install --id FiloSottile.age -e',
          hint: ''
        };
      }
      if (commandExists('choco')) {
        return {
          platform: 'Windows',
          command: 'choco install age -y',
          hint: ''
        };
      }
      return {
        platform: 'Windows',
        command: '',
        hint: 'Install age manually from https://github.com/FiloSottile/age/releases and ensure age.exe is in PATH.'
      };
    }

    if (commandExists('apt-get')) {
      return {
        platform: 'Linux',
        command: 'sudo apt-get update && sudo apt-get install -y age',
        hint: ''
      };
    }
    if (commandExists('dnf')) {
      return {
        platform: 'Linux',
        command: 'sudo dnf install -y age',
        hint: ''
      };
    }
    if (commandExists('yum')) {
      return {
        platform: 'Linux',
        command: 'sudo yum install -y age',
        hint: ''
      };
    }
    if (commandExists('pacman')) {
      return {
        platform: 'Linux',
        command: 'sudo pacman -Sy --noconfirm age',
        hint: ''
      };
    }
    if (commandExists('zypper')) {
      return {
        platform: 'Linux',
        command: 'sudo zypper install -y age',
        hint: ''
      };
    }
    return {
      platform: 'Linux',
      command: '',
      hint: 'No supported package manager detected. Install age manually.'
    };
  }

  function printAgeInstallGuidance() {
    const plan = getAgeInstallHints();
    console.log('\x1b[33m[aih]\x1b[0m age CLI is required for SSH-key encryption/decryption.');
    if (plan.command) {
      console.log(`\x1b[90m[Hint]\x1b[0m ${plan.platform} install command: ${plan.command}`);
    }
    if (plan.hint) {
      console.log(`\x1b[90m[Hint]\x1b[0m ${plan.hint}`);
    }
  }

  function tryAutoInstallAge() {
    const plan = getAgeInstallHints();
    if (!plan.command) {
      printAgeInstallGuidance();
      return false;
    }

    printAgeInstallGuidance();
    const autoInstallByEnv = String(processObj.env.AIH_AUTO_INSTALL_AGE || '').trim() === '1';
    const interactive = !!(processObj.stdin && processObj.stdin.isTTY && processObj.stdout && processObj.stdout.isTTY);
    if (!interactive && !autoInstallByEnv) {
      console.log('\x1b[90m[Hint]\x1b[0m Non-interactive shell detected. Set AIH_AUTO_INSTALL_AGE=1 to auto-install age.');
      return false;
    }

    const shouldInstall = autoInstallByEnv ? true : askYesNo('Do you want ai-home to run this install command now?', true);
    if (!shouldInstall) return false;

    try {
      console.log(`\x1b[36m[aih]\x1b[0m Installing age via: ${plan.command}`);
      execSync(plan.command, { stdio: 'inherit' });
    } catch (error) {
      console.error(`\x1b[31m[aih] Failed to install age automatically: ${error.message}\x1b[0m`);
      return false;
    }

    if (!hasAgeBinary()) {
      console.error('\x1b[31m[aih] age install command finished, but age is still not found in PATH.\x1b[0m');
      return false;
    }
    console.log('\x1b[32m[aih] age is now available.\x1b[0m');
    return true;
  }

  function readSshPublicKeyParts(pubKeyPath) {
    const text = String(fs.readFileSync(pubKeyPath, 'utf8')).trim();
    const parts = text.split(/\s+/);
    if (parts.length < 2) return null;
    const keyType = parts[0];
    const keyBody = parts[1];
    const comment = parts.slice(2).join(' ') || '';
    return { keyType, keyBody, comment };
  }

  function getAgeCompatibleSshPublicKeys() {
    const sshDir = path.join(hostHomeDir, '.ssh');
    if (!fs.existsSync(sshDir)) return [];
    return fs.readdirSync(sshDir)
      .filter((name) => name.startsWith('id_') && name.endsWith('.pub'))
      .map((name) => {
        const pubPath = path.join(sshDir, name);
        try {
          const parts = readSshPublicKeyParts(pubPath);
          if (!parts || !ageSshKeyTypes.has(parts.keyType)) return null;
          return {
            pubFile: name,
            privateFile: name.replace(/\.pub$/, ''),
            keyType: parts.keyType,
            recipient: `${parts.keyType} ${parts.keyBody}`,
            comment: parts.comment
          };
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  }

  function getAgeCompatibleSshPrivateKeys() {
    const sshDir = path.join(hostHomeDir, '.ssh');
    return getAgeCompatibleSshPublicKeys()
      .map((entry) => {
        const privatePath = path.join(sshDir, entry.privateFile);
        if (!fs.existsSync(privatePath)) return null;
        return {
          privateFile: entry.privateFile,
          privatePath,
          keyType: entry.keyType,
          comment: entry.comment
        };
      })
      .filter(Boolean);
  }

  function isAgeArmoredData(buffer) {
    if (!buffer || buffer.length === 0) return false;
    const header = buffer.subarray(0, 96).toString('utf8');
    return header.includes('BEGIN AGE ENCRYPTED FILE');
  }

  function runAgeEncrypt(inputTarPath, outputPath, recipient) {
    const result = spawnSync('age', ['--encrypt', '--armor', '-r', recipient, '-o', outputPath, inputTarPath], {
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      const message = (result.stderr || result.stdout || '').trim() || 'age encryption failed.';
      throw new Error(message);
    }
  }

  function runAgeDecrypt(inputFilePath, outputTarPath, identityPath) {
    const result = spawnSync('age', ['--decrypt', '-i', identityPath, '-o', outputTarPath, inputFilePath], {
      stdio: 'inherit'
    });
    if (result.status !== 0) {
      throw new Error(`age decryption failed with ~/.ssh/${path.basename(identityPath)}.`);
    }
  }

  function createPrivateKeyObject(privateKeyContent, passphrase) {
    return crypto.createPrivateKey({
      key: privateKeyContent,
      passphrase: passphrase || undefined
    });
  }

  function loadRsaPrivateKey(privateKeyPath, passphrase) {
    const keyContent = fs.readFileSync(privateKeyPath, 'utf8');
    const keyObj = createPrivateKeyObject(keyContent, passphrase);
    const keyType = String(keyObj.asymmetricKeyType || '');
    if (!keyType.startsWith('rsa')) {
      throw new Error(`Unsupported SSH key type "${keyType}". Only RSA keys are supported for public-key encryption.`);
    }
    return keyObj;
  }

  function derivePasswordKey(password, salt) {
    return crypto.scryptSync(password, salt, 32);
  }

  function readFixedRange(filePath, start, size) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const out = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, out, 0, size, start);
      return out.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  }

  function readPasswordArchiveHeader(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < PASSWORD_FILE_HEADER_LEN + PASSWORD_FILE_TAG_LEN) return null;
    const header = readFixedRange(filePath, 0, PASSWORD_FILE_HEADER_LEN);
    const magic = header.subarray(0, PASSWORD_FILE_MAGIC.length);
    if (!magic.equals(PASSWORD_FILE_MAGIC)) return null;
    const saltStart = PASSWORD_FILE_MAGIC.length;
    const ivStart = saltStart + PASSWORD_FILE_SALT_LEN;
    return {
      salt: header.subarray(saltStart, ivStart),
      iv: header.subarray(ivStart, ivStart + PASSWORD_FILE_IV_LEN),
      fileSize: stat.size
    };
  }

  function isPasswordArchiveFile(filePath) {
    try {
      return !!readPasswordArchiveHeader(filePath);
    } catch (_error) {
      return false;
    }
  }

  function encryptTarWithPassword(inputTarPath, outputPath, password) {
    const salt = crypto.randomBytes(PASSWORD_FILE_SALT_LEN);
    const iv = crypto.randomBytes(PASSWORD_FILE_IV_LEN);
    const key = derivePasswordKey(password, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const header = Buffer.concat([PASSWORD_FILE_MAGIC, salt, iv]);

    return new Promise((resolve, reject) => {
      const input = fs.createReadStream(inputTarPath);
      const output = fs.createWriteStream(outputPath);
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        input.destroy();
        cipher.destroy();
        output.destroy();
        reject(error);
      };

      input.on('error', fail);
      cipher.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      output.write(header, (error) => {
        if (error) {
          fail(error);
          return;
        }
        input.pipe(cipher).pipe(output, { end: false });
        cipher.once('end', () => {
          try {
            const tag = cipher.getAuthTag();
            output.end(tag);
          } catch (tagError) {
            fail(tagError);
          }
        });
      });
    });
  }

  function decryptPasswordArchive(inputFilePath, outputTarPath, password) {
    const header = readPasswordArchiveHeader(inputFilePath);
    if (!header) {
      throw new Error('Invalid password-encrypted backup file.');
    }

    const key = derivePasswordKey(password, header.salt);
    const tagOffset = header.fileSize - PASSWORD_FILE_TAG_LEN;
    const tag = readFixedRange(inputFilePath, tagOffset, PASSWORD_FILE_TAG_LEN);
    if (tag.length !== PASSWORD_FILE_TAG_LEN) {
      throw new Error('Invalid encrypted backup tag.');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.iv);
    decipher.setAuthTag(tag);

    return new Promise((resolve, reject) => {
      const input = fs.createReadStream(inputFilePath, {
        start: PASSWORD_FILE_HEADER_LEN,
        end: tagOffset - 1
      });
      const output = fs.createWriteStream(outputTarPath);
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        input.destroy();
        decipher.destroy();
        output.destroy();
        if (fs.existsSync(outputTarPath)) {
          try {
            fs.unlinkSync(outputTarPath);
          } catch (_unlinkError) {}
        }
        if (error && /authenticate data|Unsupported state/i.test(String(error.message || ''))) {
          reject(new Error('Decryption failed: wrong password or corrupted backup.'));
          return;
        }
        reject(error);
      };

      input.on('error', fail);
      decipher.on('error', fail);
      output.on('error', fail);
      output.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });

      input.pipe(decipher).pipe(output);
    });
  }

  function encryptWithAesGcm(plainBuffer, key) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ciphertext: ciphertext.toString('base64')
    };
  }

  function decryptWithAesGcm(payload, key) {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  function buildPasswordEnvelope(plainBuffer, password) {
    const salt = crypto.randomBytes(16);
    const key = derivePasswordKey(password, salt);
    const encrypted = encryptWithAesGcm(plainBuffer, key);
    return {
      version: exportVersion,
      mode: 'password',
      kdf: {
        type: 'scrypt',
        salt: salt.toString('base64')
      },
      ...encrypted
    };
  }

  function decryptPasswordEnvelope(envelope, password) {
    if (!envelope.kdf || envelope.kdf.type !== 'scrypt' || !envelope.kdf.salt) {
      throw new Error('Invalid password envelope.');
    }
    const salt = Buffer.from(envelope.kdf.salt, 'base64');
    const key = derivePasswordKey(password, salt);
    return decryptWithAesGcm(envelope, key);
  }

  function decryptSshRsaEnvelope(envelope, privateKeyObj) {
    if (!envelope.wrappedKey) throw new Error('Missing wrappedKey in SSH envelope.');
    const dataKey = crypto.privateDecrypt(
      {
        key: privateKeyObj,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      Buffer.from(envelope.wrappedKey, 'base64')
    );
    return decryptWithAesGcm(envelope, dataKey);
  }

  function serializeEnvelope(envelope) {
    return Buffer.from(`${exportMagic}${JSON.stringify(envelope)}`, 'utf8');
  }

  function parseEnvelope(buffer) {
    const asText = buffer.toString('utf8');
    if (!asText.startsWith(exportMagic)) return null;
    const payload = JSON.parse(asText.slice(exportMagic.length));
    if (!payload || payload.version !== exportVersion) {
      throw new Error('Unsupported export format version.');
    }
    return payload;
  }

  function decryptLegacyEnvelope(buffer, secret) {
    const salt = buffer.subarray(0, 16);
    const iv = buffer.subarray(16, 28);
    const tag = buffer.subarray(28, 44);
    const encrypted = buffer.subarray(44);
    const key = derivePasswordKey(secret, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  return {
    getSshKeys,
    getLikelyRsaSshPrivateKeys,
    hasAgeBinary,
    tryAutoInstallAge,
    getAgeCompatibleSshPublicKeys,
    getAgeCompatibleSshPrivateKeys,
    isAgeArmoredData,
    runAgeEncrypt,
    runAgeDecrypt,
    loadRsaPrivateKey,
    decryptSshRsaEnvelope,
    isPasswordArchiveFile,
    encryptTarWithPassword,
    decryptPasswordArchive,
    buildPasswordEnvelope,
    decryptPasswordEnvelope,
    serializeEnvelope,
    parseEnvelope,
    decryptLegacyEnvelope
  };
}

module.exports = {
  createBackupCryptoService
};
