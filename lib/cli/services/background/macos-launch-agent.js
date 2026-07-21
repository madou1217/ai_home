'use strict';

const { performance } = require('node:perf_hooks');

const BACKGROUND_LAUNCHD_LABEL = 'com.clawdcodex.ai_home';
const BACKGROUND_BUNDLE_ID = 'com.aih.background';
const BACKGROUND_APP_NAME = 'AI Home';
const DEFAULT_STOP_WAIT_TIMEOUT_MS = 25000;
const DEFAULT_STOP_POLL_INTERVAL_MS = 100;
const DEFAULT_LAUNCHCTL_COMMAND_TIMEOUT_MS = 5000;

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createMacosLaunchAgent(options = {}, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const path = deps.path || require('node:path');
  const spawnSync = deps.spawnSync;
  const processObj = deps.processObj || process;
  const ensureDir = typeof deps.ensureDir === 'function'
    ? deps.ensureDir
    : (directory) => fs.mkdirSync(directory, { recursive: true });
  const hostHomeDir = nonEmptyString(options.hostHomeDir);
  const aiHomeDir = nonEmptyString(options.aiHomeDir) || path.join(hostHomeDir, '.ai_home');
  const label = nonEmptyString(options.label) || BACKGROUND_LAUNCHD_LABEL;
  const launchdPlist = nonEmptyString(options.launchdPlist)
    || path.join(hostHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  const logFile = nonEmptyString(options.logFile)
    || path.join(aiHomeDir, 'logs', 'services', 'background-supervisor.log');
  const appPath = nonEmptyString(options.appPath)
    || path.join(hostHomeDir, 'Library', 'Application Support', BACKGROUND_APP_NAME, `${BACKGROUND_APP_NAME}.app`);
  const appExecutable = path.join(appPath, 'Contents', 'MacOS', 'AIHomeBackground');
  const iconSourcePath = nonEmptyString(options.iconSourcePath)
    || path.resolve(__dirname, '..', '..', '..', '..', 'src-tauri', 'icons', 'icon.icns');
  const launchServicesPath = nonEmptyString(options.launchServicesPath)
    || '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  const now = typeof deps.now === 'function' ? deps.now : () => performance.now();
  const sleepSync = typeof deps.sleepSync === 'function'
    ? deps.sleepSync
    : (delayMs) => {
      const buffer = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buffer), 0, 0, delayMs);
    };
  const legacyServices = Array.isArray(options.legacyServices)
    ? options.legacyServices
      .map((service) => ({
        label: nonEmptyString(service && service.label),
        file: nonEmptyString(service && service.file)
      }))
      .filter((service) => service.label && service.label !== label && service.file)
    : [];

  function run(command, args, runOptions = {}) {
    if (typeof spawnSync !== 'function') {
      return { status: 1, stdout: '', stderr: 'spawnSync is not available' };
    }
    try {
      return spawnSync(command, args, runOptions);
    } catch (error) {
      return { status: 1, stdout: '', stderr: error.message || String(error), error };
    }
  }

  function userDomain() {
    const uid = typeof processObj.getuid === 'function'
      ? processObj.getuid()
      : (typeof process.getuid === 'function' ? process.getuid() : 501);
    return `gui/${uid}`;
  }

  function resolveAihCommandPath() {
    const resolver = options.resolveAihCommandPath;
    const resolved = typeof resolver === 'function' ? resolver() : options.aihCommandPath;
    const commandPath = nonEmptyString(resolved);
    if (commandPath) return commandPath;
    const error = new Error('aih command is required for macOS background supervisor');
    error.code = 'aih_command_required';
    throw error;
  }

  function buildInfoPlist() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDisplayName</key>
    <string>${BACKGROUND_APP_NAME}</string>
    <key>CFBundleExecutable</key>
    <string>AIHomeBackground</string>
    <key>CFBundleIconFile</key>
    <string>AIHome</string>
    <key>CFBundleIdentifier</key>
    <string>${BACKGROUND_BUNDLE_ID}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${BACKGROUND_APP_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSBackgroundOnly</key>
    <true/>
  </dict>
</plist>
`;
  }

  function installAppBundle() {
    if (!fs.existsSync(iconSourcePath)) {
      const error = new Error(`AI Home icon is missing: ${iconSourcePath}`);
      error.code = 'background_supervisor_icon_missing';
      throw error;
    }
    const contentsDir = path.join(appPath, 'Contents');
    const macosDir = path.join(contentsDir, 'MacOS');
    const resourcesDir = path.join(contentsDir, 'Resources');
    ensureDir(macosDir);
    ensureDir(resourcesDir);
    fs.writeFileSync(path.join(contentsDir, 'Info.plist'), buildInfoPlist());
    fs.writeFileSync(appExecutable, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    if (typeof fs.chmodSync === 'function') fs.chmodSync(appExecutable, 0o755);
    fs.copyFileSync(iconSourcePath, path.join(resourcesDir, 'AIHome.icns'));

    if (fs.existsSync(launchServicesPath)) {
      const registered = run(launchServicesPath, ['-f', appPath], { encoding: 'utf8' });
      if (!resultSucceeded(registered)) {
        const error = new Error(`AI Home background app registration failed: ${resultMessage(registered)}`);
        error.code = 'background_supervisor_app_registration_failed';
        error.appPath = appPath;
        throw error;
      }
    }
  }

  function buildPlist() {
    const programArguments = [appExecutable, resolveAihCommandPath(), '__background', 'run']
      .map((argument) => `      <string>${escapeXml(argument)}</string>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>AssociatedBundleIdentifiers</key>
    <array>
      <string>${BACKGROUND_BUNDLE_ID}</string>
    </array>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ExitTimeOut</key>
    <integer>20</integer>
    <key>ProcessType</key>
    <string>Standard</string>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logFile)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${escapeXml(hostHomeDir)}</string>
      <key>PATH</key>
      <string>${escapeXml(processObj.env && processObj.env.PATH || '')}</string>
    </dict>
  </dict>
</plist>
`;
  }

  function bootstrap(plistFile) {
    const modern = runLaunchctl(['bootstrap', userDomain(), plistFile]);
    if (resultSucceeded(modern) || resultIndeterminate(modern)) return modern;
    return runLaunchctl(['load', plistFile]);
  }

  function resultSucceeded(result) {
    return Boolean(result && Number.isInteger(result.status) && result.status === 0);
  }

  function resultIndeterminate(result) {
    return Boolean(result && (
      (result.error && result.error.code === 'ETIMEDOUT')
      || (result.status === null && result.signal)
    ));
  }

  function resultMessage(result) {
    const message = nonEmptyString(result && (result.stderr || result.stdout || (result.error && result.error.message)));
    if (message) return message;
    if (result && Number.isInteger(result.status)) {
      return `launchctl exited with status ${result.status}`;
    }
    return `launchctl terminated${nonEmptyString(result && result.signal) ? ` by ${result.signal}` : ''}`;
  }

  function createLaunchctlError(code, action, service, results = []) {
    const finalResult = results[results.length - 1];
    const error = new Error(`${action} failed for ${service.label}: ${resultMessage(finalResult)}`);
    error.code = code;
    error.action = action;
    error.label = service.label;
    error.file = service.file || '';
    error.results = results;
    return error;
  }

  function resultMeansJobMissing(result) {
    if (resultSucceeded(result)) return false;
    if (!result || result.error || result.status === null || result.signal) return false;
    const message = nonEmptyString(result && (result.stderr || result.stdout)).toLowerCase();
    if (!message) return true;
    return /(?:could not find|not found|no such process|does not exist|unknown service)/.test(message);
  }

  function createStopTimeoutError(service) {
    const error = new Error(`timed out waiting for ${service.label} to unload`);
    error.code = 'background_launchd_stop_timeout';
    error.label = service.label;
    return error;
  }

  function createStopContext(service) {
    const timeoutMs = Math.max(
      1,
      Number(options.stopWaitTimeoutMs) || DEFAULT_STOP_WAIT_TIMEOUT_MS
    );
    return {
      service,
      deadline: now() + timeoutMs
    };
  }

  function remainingStopTime(context) {
    const remainingMs = Math.ceil(context.deadline - now());
    if (remainingMs <= 0) throw createStopTimeoutError(context.service);
    return remainingMs;
  }

  function runLaunchctl(args, stopContext = null) {
    const timeout = stopContext
      ? remainingStopTime(stopContext)
      : DEFAULT_LAUNCHCTL_COMMAND_TIMEOUT_MS;
    const result = run('launchctl', args, { encoding: 'utf8', timeout });
    if (stopContext && resultIndeterminate(result)) {
      throw createStopTimeoutError(stopContext.service);
    }
    return result;
  }

  function queryJob(serviceLabel, stopContext = null) {
    const modern = runLaunchctl(['print', `${userDomain()}/${serviceLabel}`], stopContext);
    if (resultSucceeded(modern)) return { loaded: true, results: [modern] };
    const legacy = runLaunchctl(['list', serviceLabel], stopContext);
    if (resultSucceeded(legacy)) return { loaded: true, results: [modern, legacy] };
    const results = [modern, legacy];
    if (results.every(resultMeansJobMissing)) return { loaded: false, results };
    throw createLaunchctlError(
      'background_launchd_status_failed',
      'query',
      { label: serviceLabel, file: '' },
      results
    );
  }

  function stopJob(service, errorCode = 'background_launchd_stop_failed') {
    const stopContext = createStopContext(service);
    const modern = runLaunchctl(['bootout', `${userDomain()}/${service.label}`], stopContext);
    if (resultSucceeded(modern)) {
      waitForJobUnloaded(service, stopContext);
      return { method: 'bootout', results: [modern] };
    }
    const results = [modern];
    if (service.file) {
      const legacy = runLaunchctl(['unload', service.file], stopContext);
      results.push(legacy);
      if (resultSucceeded(legacy)) {
        waitForJobUnloaded(service, stopContext);
        return { method: 'unload', results };
      }
    }
    throw createLaunchctlError(errorCode, 'stop', service, results);
  }

  function waitForJobUnloaded(service, stopContext) {
    const pollIntervalMs = Math.max(
      1,
      Number(options.stopPollIntervalMs) || DEFAULT_STOP_POLL_INTERVAL_MS
    );
    while (queryJob(service.label, stopContext).loaded) {
      sleepSync(Math.min(pollIntervalMs, remainingStopTime(stopContext)));
    }
  }

  let backupSequence = 0;

  function nextBackupPath(file) {
    backupSequence += 1;
    const pid = Number(processObj.pid) || Number(process.pid) || 0;
    return `${file}.aih-rollback-${pid}-${Date.now()}-${backupSequence}`;
  }

  function captureJob(service) {
    const installed = Boolean(service.file && fs.existsSync(service.file));
    const status = queryJob(service.label);
    return {
      label: service.label,
      file: service.file || '',
      installed,
      loaded: status.loaded,
      content: installed ? fs.readFileSync(service.file) : null,
      backupFile: '',
      stopped: false
    };
  }

  function stagePlist(snapshot) {
    if (!snapshot.installed) return;
    if (!snapshot.file || !fs.existsSync(snapshot.file)) {
      const error = new Error(`plist disappeared before it could be staged: ${snapshot.file}`);
      error.code = 'background_launchd_plist_missing';
      throw error;
    }
    snapshot.backupFile = nextBackupPath(snapshot.file);
    fs.renameSync(snapshot.file, snapshot.backupFile);
  }

  function restorePlistFile(snapshot, removeReplacement = false) {
    if (!snapshot || !snapshot.file) return;
    if (snapshot.backupFile && fs.existsSync(snapshot.backupFile)) {
      if (fs.existsSync(snapshot.file)) fs.unlinkSync(snapshot.file);
      fs.renameSync(snapshot.backupFile, snapshot.file);
      return;
    }
    if (snapshot.installed) {
      if (!fs.existsSync(snapshot.file) && snapshot.content !== null) {
        fs.writeFileSync(snapshot.file, snapshot.content);
      }
      return;
    }
    if (removeReplacement && fs.existsSync(snapshot.file)) fs.unlinkSync(snapshot.file);
  }

  function startSnapshot(snapshot, errorCode) {
    if (!snapshot || !snapshot.loaded) return;
    if (!snapshot.file || !fs.existsSync(snapshot.file)) {
      const missing = new Error(`cannot restore loaded job without plist: ${snapshot && snapshot.label}`);
      missing.code = 'background_launchd_restore_plist_missing';
      missing.label = snapshot && snapshot.label;
      throw missing;
    }
    const result = bootstrap(snapshot.file);
    if (!resultSucceeded(result)) {
      throw createLaunchctlError(errorCode, 'restore', snapshot, [result]);
    }
  }

  function cleanupLegacyServices(transaction) {
    for (const service of legacyServices) {
      const snapshot = captureJob(service);
      if (!snapshot.installed && !snapshot.loaded) continue;
      if (snapshot.loaded && !snapshot.installed) {
        const error = new Error(`cannot migrate loaded legacy job without plist: ${snapshot.label}`);
        error.code = 'background_legacy_service_plist_missing';
        error.label = snapshot.label;
        throw error;
      }
      transaction.legacy.push(snapshot);
      if (snapshot.loaded) {
        stopJob(snapshot, 'background_legacy_service_stop_failed');
        snapshot.stopped = true;
      }
      stagePlist(snapshot);
    }
  }

  function restoreLegacyFiles(transaction, rollbackErrors) {
    for (const snapshot of transaction.legacy) {
      try {
        restorePlistFile(snapshot);
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
  }

  function restartPreviousJobs(transaction, rollbackErrors) {
    if (!transaction.stateRestored || !transaction.replacementStopped) return;
    if (transaction.supervisorStopped) {
      try {
        startSnapshot(transaction.supervisor, 'background_supervisor_restore_failed');
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    for (const snapshot of transaction.legacy) {
      if (!snapshot.stopped) continue;
      try {
        startSnapshot(snapshot, 'background_legacy_service_restore_failed');
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
  }

  function createRollbackError(cause, rollbackErrors) {
    const error = new Error(`background supervisor rollback failed after ${nonEmptyString(cause && cause.code) || 'operation error'}`);
    error.code = 'background_supervisor_rollback_failed';
    error.cause = cause;
    error.rollbackErrors = rollbackErrors;
    return error;
  }

  function rollbackAndThrow(cause, transaction, restoreState) {
    const rollbackErrors = [];
    transaction.stateRestored = true;
    if (typeof restoreState === 'function') {
      try {
        restoreState();
      } catch (error) {
        transaction.stateRestored = false;
        rollbackErrors.push(error);
      }
    }

    transaction.replacementStopped = true;
    if (transaction.newSupervisorLoadAttempted) {
      try {
        const replacement = { label, file: launchdPlist };
        if (queryJob(label).loaded) {
          stopJob(replacement, 'background_supervisor_rollback_stop_failed');
        }
      } catch (error) {
        transaction.replacementStopped = false;
        rollbackErrors.push(error);
      }
    }

    if (transaction.stateRestored
      && transaction.replacementStopped
      && (transaction.supervisorStopped || transaction.newPlistInstalled)) {
      try {
        restorePlistFile(transaction.supervisor, transaction.newPlistInstalled);
      } catch (error) {
        transaction.replacementStopped = false;
        rollbackErrors.push(error);
      }
    }
    restoreLegacyFiles(transaction, rollbackErrors);
    restartPreviousJobs(transaction, rollbackErrors);

    if (rollbackErrors.length > 0) throw createRollbackError(cause, rollbackErrors);
    throw cause;
  }

  function discardBackup(snapshot) {
    if (snapshot && snapshot.backupFile && fs.existsSync(snapshot.backupFile)) {
      fs.unlinkSync(snapshot.backupFile);
    }
  }

  function commitTransaction(transaction) {
    for (const snapshot of transaction.legacy) discardBackup(snapshot);
    discardBackup(transaction.supervisor);
  }

  function createTransaction() {
    return {
      supervisor: null,
      supervisorStopped: false,
      newPlistInstalled: false,
      newSupervisorLoadAttempted: false,
      replacementStopped: false,
      stateRestored: false,
      legacy: []
    };
  }

  function getStatus() {
    const installed = fs.existsSync(launchdPlist);
    const loaded = queryJob(label).loaded;
    return {
      supported: true,
      type: 'launchd',
      installed,
      loaded,
      file: launchdPlist,
      plist: launchdPlist,
      logFile,
      label,
      appPath
    };
  }

  function install(transactionOptions = {}) {
    ensureDir(path.dirname(launchdPlist));
    ensureDir(path.dirname(logFile));
    const transaction = createTransaction();
    const temporaryPlist = `${launchdPlist}.${process.pid}.${Date.now()}.tmp`;
    try {
      transaction.supervisor = captureJob({ label, file: launchdPlist });
      installAppBundle();
      fs.writeFileSync(temporaryPlist, buildPlist());
      if (transaction.supervisor.loaded) {
        stopJob(transaction.supervisor);
        transaction.supervisorStopped = true;
      }
      if (transaction.supervisor.installed) {
        stagePlist(transaction.supervisor);
      }
      fs.renameSync(temporaryPlist, launchdPlist);
      transaction.newPlistInstalled = true;
      transaction.newSupervisorLoadAttempted = true;
      const loaded = bootstrap(launchdPlist);
      if (!resultSucceeded(loaded)) {
        const message = nonEmptyString(loaded.stderr || loaded.stdout) || 'launchctl bootstrap failed';
        const error = new Error(message);
        error.code = 'background_supervisor_bootstrap_failed';
        throw error;
      }
      cleanupLegacyServices(transaction);
      commitTransaction(transaction);
      return getStatus();
    } catch (error) {
      return rollbackAndThrow(error, transaction, transactionOptions.restoreState);
    } finally {
      try { fs.unlinkSync(temporaryPlist); } catch (_error) {}
    }
  }

  function uninstall(transactionOptions = {}) {
    const transaction = createTransaction();
    try {
      transaction.supervisor = captureJob({ label, file: launchdPlist });
      if (transaction.supervisor.loaded) {
        stopJob(transaction.supervisor);
        transaction.supervisorStopped = true;
      }
      if (transaction.supervisor.installed) {
        stagePlist(transaction.supervisor);
      }
      cleanupLegacyServices(transaction);
      if (fs.existsSync(appPath)) fs.rmSync(appPath, { recursive: true, force: true });
      commitTransaction(transaction);
      return getStatus();
    } catch (error) {
      return rollbackAndThrow(error, transaction, transactionOptions.restoreState);
    }
  }

  function stopLoaded() {
    const snapshot = captureJob({ label, file: launchdPlist });
    if (!snapshot.loaded) return getStatus();
    stopJob(snapshot);
    return getStatus();
  }

  return {
    getStatus,
    install,
    stopLoaded,
    uninstall
  };
}

module.exports = {
  BACKGROUND_APP_NAME,
  BACKGROUND_BUNDLE_ID,
  BACKGROUND_LAUNCHD_LABEL,
  createMacosLaunchAgent
};
