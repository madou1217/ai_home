'use strict';

// SSH MCP server loop: exposes a remote host (over ssh + ControlMaster) as MCP
// tools (read/write/run/list) for a locally-launched provider CLI. Started by
// `aih __ssh_mcp__` (see spawnPty's AIH_REMOTE_SSH wiring); runs as its own
// process speaking JSON-RPC on stdio — fully independent of the PTY runtime.

function runSshMcpServerLoop(sshTarget, remoteRoot, processObj = process) {
  const child_process = require('node:child_process');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  if (!sshTarget || !remoteRoot) {
    processObj.stderr.write(`[AIH-SSH-MCP] Error: missing sshTarget or remoteRoot\n`);
    processObj.exit(1);
    return;
  }

  // 1. 初始化本地临时影子路径与控制套接字路径
  const cleanTarget = String(sshTarget).trim();
  const cleanRoot = String(remoteRoot).trim().replace(/\/+$/, '');
  const localShadowDir = path.join(os.tmpdir(), `aih-shadow-${crypto.createHash('sha256').update(cleanTarget + cleanRoot).digest('hex').slice(0, 12)}`);
  const controlSocketPath = path.join(os.tmpdir(), `aih-ssh-ctrl-${crypto.createHash('sha256').update(cleanTarget).digest('hex').slice(0, 8)}.sock`);

  let isWindowsRemote = false;
  let fileTreeIndex = new Set();
  const fileMetadataCache = new Map();

  // 执行远程 SSH 指令
  function runRemoteCommand(commandString) {
    return new Promise((resolve, reject) => {
      const args = [];
      if (processObj.platform !== 'win32' && fs.existsSync(controlSocketPath)) {
        args.push('-o', `ControlPath=${controlSocketPath}`);
      }
      args.push(cleanTarget, commandString);

      const child = child_process.spawn('ssh', args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`远程执行失败(Exit Code ${code}): ${stderr.trim()}`));
      });
    });
  }

  // 清理生命周期
  function cleanup() {
    if (processObj.platform !== 'win32' && fs.existsSync(controlSocketPath)) {
      try {
        child_process.execSync(`ssh -O exit -o ControlPath="${controlSocketPath}" "${cleanTarget}"`, { stdio: 'ignore' });
        fs.unlinkSync(controlSocketPath);
      } catch (_e) {}
    }
    if (fs.existsSync(localShadowDir)) {
      try {
        fs.rmSync(localShadowDir, { recursive: true, force: true });
      } catch (_e) {}
    }
  }

  if (typeof processObj.on === 'function') {
    processObj.on('exit', cleanup);
    processObj.on('SIGINT', () => { cleanup(); processObj.exit(0); });
    processObj.on('SIGTERM', () => { cleanup(); processObj.exit(0); });
  }

  // 连接初始化和远端探测
  async function initializeSshConnection() {
    if (!fs.existsSync(localShadowDir)) {
      fs.mkdirSync(localShadowDir, { recursive: true });
    }

    if (processObj.platform !== 'win32') {
      const sshInitCmd = `ssh -M -f -N -o ControlPath="${controlSocketPath}" -o ControlPersist=10m "${cleanTarget}"`;
      try {
        child_process.execSync(sshInitCmd, { stdio: 'ignore' });
      } catch (err) {
        processObj.stderr.write(`[AIH-SSH-MCP] Warning: SSH ControlMaster setup failed: ${err.message}. Running without control master.\n`);
      }
    }

    try {
      const winProbe = await runRemoteCommand('cmd /c "echo %OS%"');
      if (winProbe.includes('Windows')) {
        isWindowsRemote = true;
      }
    } catch (_e) {}

    // 索引预加载
    try {
      let fileListRaw = '';
      if (isWindowsRemote) {
        fileListRaw = await runRemoteCommand(`powershell -Command "Get-ChildItem -Path '${cleanRoot}' -Recurse -File | Resolve-Path -Relative"`);
      } else {
        try {
          fileListRaw = await runRemoteCommand(`cd "${cleanRoot}" && git ls-files`);
        } catch (_e) {
          fileListRaw = await runRemoteCommand(`find "${cleanRoot}" -type f -not -path "*/node_modules/*" -not -path "*/.*"`);
        }
      }
      fileTreeIndex.clear();
      fileListRaw.split('\n').map(line => line.trim()).filter(Boolean).forEach(file => {
        fileTreeIndex.add(file.replace(/\\/g, '/'));
      });
    } catch (err) {
      processObj.stderr.write(`[AIH-SSH-MCP] File indexing failed: ${err.message}\n`);
    }
  }

  // 懒加载读文件
  async function mcpReadFile(relPath) {
    const normPath = relPath.replace(/\\/g, '/');
    const localPath = path.join(localShadowDir, normPath);
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    const remotePath = isWindowsRemote
      ? `${cleanRoot}\\${normPath.replace(/\//g, '\\')}`
      : `${cleanRoot}/${normPath}`;

    let metaString = '';
    try {
      if (isWindowsRemote) {
        metaString = await runRemoteCommand(`powershell -Command "(Get-Item '${remotePath}').LastWriteTime.Ticks.ToString() + ',' + (Get-Item '${remotePath}').Length"`);
      } else {
        metaString = await runRemoteCommand(`stat -c "%Y,%s" "${remotePath}" 2>/dev/null || stat -f "%m,%z" "${remotePath}"`);
      }
      const [mtime, size] = metaString.split(',');
      fileMetadataCache.set(normPath, { mtime: mtime.trim(), size: size.trim() });
    } catch (_e) {}

    let content = '';
    if (isWindowsRemote) {
      content = await runRemoteCommand(`powershell -Command "[System.IO.File]::ReadAllText('${remotePath}', [System.Text.Encoding]::UTF8)"`);
    } else {
      content = await runRemoteCommand(`cat "${remotePath}"`);
    }

    fs.writeFileSync(localPath, content, 'utf8');
    return content;
  }

  // 原子提交写文件 + SHA256 验证 + 乐观锁冲突检测
  async function mcpWriteFile(relPath, content) {
    const normPath = relPath.replace(/\\/g, '/');
    const localPath = path.join(localShadowDir, normPath);
    const remotePath = isWindowsRemote
      ? `${cleanRoot}\\${normPath.replace(/\//g, '\\')}`
      : `${cleanRoot}/${normPath}`;

    // 冲突检查
    const cachedMeta = fileMetadataCache.get(normPath);
    if (cachedMeta) {
      let currentMeta = '';
      try {
        if (isWindowsRemote) {
          currentMeta = await runRemoteCommand(`powershell -Command "(Get-Item '${remotePath}').LastWriteTime.Ticks.ToString() + ',' + (Get-Item '${remotePath}').Length"`);
        } else {
          currentMeta = await runRemoteCommand(`stat -c "%Y,%s" "${remotePath}" 2>/dev/null || stat -f "%m,%z" "${remotePath}"`);
        }
      } catch (_e) {}
      if (currentMeta) {
        const [curMtime, curSize] = currentMeta.split(',');
        if (curMtime.trim() !== cachedMeta.mtime || curSize.trim() !== cachedMeta.size) {
          throw new Error(`[Conflict] 远端文件已被其他人手动修改，请重试以重新拉取: ${relPath}`);
        }
      }
    }

    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    fs.writeFileSync(localPath, content, 'utf8');
    const localSha256 = crypto.createHash('sha256').update(content).digest('hex');

    const remoteTmpPath = `${remotePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
    const b64 = Buffer.from(content, 'utf8').toString('base64');

    if (isWindowsRemote) {
      await runRemoteCommand(`powershell -Command "[System.IO.File]::WriteAllBytes('${remoteTmpPath}', [System.Convert]::FromBase64String('${b64}'))"`);
    } else {
      await runRemoteCommand(`echo "${b64}" | base64 -d > "${remoteTmpPath}"`);
    }

    let remoteSha256 = '';
    try {
      if (isWindowsRemote) {
        remoteSha256 = await runRemoteCommand(`powershell -Command "(Get-FileHash -Path '${remoteTmpPath}' -Algorithm SHA256).Hash.ToLower()"`);
      } else {
        const shaOutput = await runRemoteCommand(`sha256sum "${remoteTmpPath}" 2>/dev/null || shasum -a 256 "${remoteTmpPath}"`);
        remoteSha256 = shaOutput.split(' ')[0].trim().toLowerCase();
      }
    } catch (err) {
      await runRemoteCommand(isWindowsRemote ? `del /f "${remoteTmpPath}"` : `rm -f "${remoteTmpPath}"`);
      throw new Error(`远端 SHA256 计算失败: ${err.message}`);
    }

    if (remoteSha256 !== localSha256) {
      await runRemoteCommand(isWindowsRemote ? `del /f "${remoteTmpPath}"` : `rm -f "${remoteTmpPath}"`);
      throw new Error(`[SHA mismatch] 传输损坏，已安全回滚临时文件。`);
    }

    if (isWindowsRemote) {
      await runRemoteCommand(`powershell -Command "Move-Item -Path '${remoteTmpPath}' -Destination '${remotePath}' -Force"`);
    } else {
      await runRemoteCommand(`mv -f "${remoteTmpPath}" "${remotePath}"`);
    }

    fileTreeIndex.add(normPath);
    let nextMeta = '';
    try {
      if (isWindowsRemote) {
        nextMeta = await runRemoteCommand(`powershell -Command "(Get-Item '${remotePath}').LastWriteTime.Ticks.ToString() + ',' + (Get-Item '${remotePath}').Length"`);
      } else {
        nextMeta = await runRemoteCommand(`stat -c "%Y,%s" "${remotePath}" 2>/dev/null || stat -f "%m,%z" "${remotePath}"`);
      }
      const [nextMtime, nextSize] = nextMeta.split(',');
      fileMetadataCache.set(normPath, { mtime: nextMtime.trim(), size: nextSize.trim() });
    } catch (_e) {}
  }

  // 运行远程命令
  async function mcpRunCommand(command) {
    let output = '';
    let exitCode = 0;
    try {
      let runCmd = '';
      if (isWindowsRemote) {
        runCmd = `powershell -Command "cd '${cleanRoot}'; ${command}"`;
      } else {
        runCmd = `cd "${cleanRoot}" && (${command})`;
      }
      output = await runRemoteCommand(runCmd);
    } catch (err) {
      output = err.message;
      exitCode = 1;
    }
    return { output, exitCode };
  }

  // 远程目录列表
  function mcpListDirectory(relPath) {
    const normDir = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const prefix = normDir ? `${normDir}/` : '';
    const files = [];
    fileTreeIndex.forEach(file => {
      if (file.startsWith(prefix)) {
        const relative = file.slice(prefix.length);
        if (!relative.includes('/')) {
          files.push({ name: relative, type: 'file' });
        } else {
          const folderName = relative.split('/')[0];
          if (!files.some(f => f.name === folderName)) {
            files.push({ name: folderName, type: 'directory' });
          }
        }
      }
    });
    return files;
  }

  // JSON-RPC 编解码状态机
  let buffer = '';
  processObj.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        handleJsonRpcMessage(line).catch((err) => {
          processObj.stderr.write(`[AIH-SSH-MCP] Message handling error: ${err.message}\n`);
        });
      }
    }
  });

  function sendResponse(id, result = {}, error = null) {
    const payload = { jsonrpc: '2.0', id };
    if (error) payload.error = error;
    else payload.result = result;
    processObj.stdout.write(JSON.stringify(payload) + '\n');
  }

  async function handleJsonRpcMessage(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      sendResponse(null, {}, { code: -32700, message: 'Parse error' });
      return;
    }

    if (req.method === 'initialize') {
      await initializeSshConnection();
      sendResponse(req.id, {
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'aih-ssh-mcp-server',
          version: '1.0.0'
        }
      });
      return;
    }

    if (req.method === 'tools/list') {
      sendResponse(req.id, {
        tools: [
          {
            name: 'view_file',
            description: 'Read the complete content of a remote file from workspace',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path of the file from remote workspace root' }
              },
              required: ['path']
            }
          },
          {
            name: 'edit_file',
            description: 'Write or replace complete file content on remote workspace',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path of the file' },
                content: { type: 'string', description: 'Complete content to write' }
              },
              required: ['path', 'content']
            }
          },
          {
            name: 'run_command',
            description: 'Execute a bash command in the remote workspace',
            inputSchema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The bash command line to run' }
              },
              required: ['command']
            }
          },
          {
            name: 'list_directory',
            description: 'List contents of a directory in the remote workspace',
            inputSchema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Relative path of the directory' }
              },
              required: ['path']
            }
          }
        ]
      });
      return;
    }

    if (req.method === 'tools/call') {
      const name = req.params && req.params.name;
      const args = (req.params && req.params.arguments) || {};
      let resultText = '';
      let isError = false;

      try {
        if (name === 'view_file') {
          resultText = await mcpReadFile(args.path);
        } else if (name === 'edit_file') {
          await mcpWriteFile(args.path, args.content);
          resultText = `Successfully wrote and verified file: ${args.path}`;
        } else if (name === 'run_command') {
          const runRes = await mcpRunCommand(args.command);
          resultText = runRes.output;
          if (runRes.exitCode !== 0) isError = true;
        } else if (name === 'list_directory') {
          const listRes = mcpListDirectory(args.path);
          resultText = listRes.map(f => `[${f.type.toUpperCase()}] ${f.name}`).join('\n') || '(empty)';
        } else {
          isError = true;
          resultText = `Unknown tool: ${name}`;
        }
      } catch (err) {
        isError = true;
        resultText = err.message;
      }

      sendResponse(req.id, {
        content: [{ type: 'text', text: resultText }],
        isError
      });
      return;
    }

    // fallback for other methods
    if (req.id != null) {
      sendResponse(req.id, {}, { code: -32601, message: 'Method not found' });
    }
  }
}

module.exports = {
  runSshMcpServerLoop
};
