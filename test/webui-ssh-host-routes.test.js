const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const { EventEmitter } = require('node:events');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { readJsonValue } = require('../lib/server/app-state-store');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

test('web ui ssh-connections & workspaces CRUD, cascade delete, key/password scrubbing and SSH browse API testing', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-ssh-split-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  let requestBody = null;
  let mockSpawn = null;

  const buildCtx = (method, pathname, res) => {
    return {
      method,
      pathname,
      req: {},
      res,
      aiHomeDir,
      deps: {
        fs,
        aiHomeDir,
        writeJson(response, code, payload) {
          response.statusCode = code;
          response.end(JSON.stringify(payload));
        },
        readRequestBody: async () => {
          if (!requestBody) return Buffer.alloc(0);
          return Buffer.from(JSON.stringify(requestBody), 'utf8');
        },
        spawnImpl: mockSpawn,
        accountStateIndex: {
          getAccountState() { return null; },
          upsertAccountState() {},
          removeAccount() {}
        },
        getToolAccountIds() { return []; },
        getToolConfigDir() { return '/tmp/config'; },
        getProfileDir() { return '/tmp/profile'; },
        loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
        applyReloadState() {},
        checkStatus() { return { configured: false, accountName: 'Unknown' }; },
        ensureSessionStoreLinks() {}
      }
    };
  };

  // ==========================================
  // 1. Connection 独立 CRUD 及其敏感值脱敏测试
  // ==========================================
  let connId = '';

  // 1.1 POST 创建连接 (带真实私钥)
  {
    const res = createResCapture();
    requestBody = {
      label: 'My-Server-Box',
      host: '192.168.1.130',
      port: 22,
      user: 'admin',
      authType: 'key',
      privateKey: '-----BEGIN PRIVATE KEY-----\nMY-SECRET-KEY\n-----END PRIVATE KEY-----'
    };

    const ctx = buildCtx('POST', '/v0/webui/ssh-connections', res);
    const handled = await handleWebUIRequest(ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.connection.label, 'My-Server-Box');
    assert.equal(data.connection.host, '192.168.1.130');
    assert.equal(data.connection.privateKey, '******'); // 验证接口回传已脱敏！
    connId = data.connection.id;
    assert.ok(connId);

    // 验证底层数据库里是否保留了真实私钥
    const saved = readJsonValue(fs, aiHomeDir, 'ssh_connections');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, connId);
    assert.equal(saved[0].privateKey, '-----BEGIN PRIVATE KEY-----\nMY-SECRET-KEY\n-----END PRIVATE KEY-----');
  }

  // 1.2 PUT 更新连接 (使用掩码 '******' 应保持数据库原真实值)
  {
    const res = createResCapture();
    requestBody = {
      label: 'Renamed-Server-Box',
      privateKey: '******' // 模拟前台传入的掩码
    };

    const ctx = buildCtx('PUT', `/v0/webui/ssh-connections/${connId}`, res);
    const handled = await handleWebUIRequest(ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.connection.label, 'Renamed-Server-Box');
    assert.equal(data.connection.privateKey, '******'); // 接口仍回传掩码

    // 验证底层数据库里的真实私钥仍被安全保留，没有被错误覆盖为 ******
    const saved = readJsonValue(fs, aiHomeDir, 'ssh_connections');
    assert.equal(saved[0].label, 'Renamed-Server-Box');
    assert.equal(saved[0].privateKey, '-----BEGIN PRIVATE KEY-----\nMY-SECRET-KEY\n-----END PRIVATE KEY-----');
  }

  // ==========================================
  // 2. Workspace 独立 CRUD 及其物理连接绑定测试
  // ==========================================
  let wsId = '';

  // 2.1 POST 创建项目工作空间
  {
    const res = createResCapture();
    requestBody = {
      connectionId: connId,
      label: 'API-Service',
      remoteRoot: '/root/app'
    };

    const ctx = buildCtx('POST', '/v0/webui/ssh-workspaces', res);
    const handled = await handleWebUIRequest(ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.workspace.label, 'API-Service');
    assert.equal(data.workspace.connectionId, connId);
    assert.equal(data.workspace.remoteRoot, '/root/app');
    wsId = data.workspace.id;
    assert.ok(wsId);

    // 验证 K-V 库是否写入
    const saved = readJsonValue(fs, aiHomeDir, 'ssh_workspaces');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, wsId);
  }

  // 2.2 GET 获取列表
  {
    const res = createResCapture();
    const ctx = buildCtx('GET', '/v0/webui/ssh-workspaces', res);
    const handled = await handleWebUIRequest(ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.workspaces.length, 1);
    assert.equal(data.workspaces[0].label, 'API-Service');
  }

  // ==========================================
  // 3. 私钥临时文件权限验证与 AskPass 注入测试
  // ==========================================
  {
    const res = createResCapture();
    requestBody = {
      connectionId: connId,
      timeoutMs: 3000
    };

    let detectedKeyPath = '';
    let detectedKeyMode = 0;

    mockSpawn = (command, args, opts = {}) => {
      assert.equal(command, 'ssh');

      // 提取 ssh 调用的私钥临时文件参数
      const iIndex = args.indexOf('-i');
      if (iIndex !== -1 && args[iIndex + 1]) {
        detectedKeyPath = args[iIndex + 1];
        if (fs.existsSync(detectedKeyPath)) {
          // 读取临时文件的属性以验证其 0o600 权限是否锁定！
          const stat = fs.statSync(detectedKeyPath);
          detectedKeyMode = stat.mode & 0o777;
        }
      }

      const processEmitter = new EventEmitter();
      processEmitter.stdout = new EventEmitter();
      processEmitter.stderr = new EventEmitter();
      processEmitter.stdin = { write: () => {}, end: () => {} };
      processEmitter.kill = () => {};

      setTimeout(() => {
        const mockProbeOutput =
          'platform=Linux\n' +
          'arch=arm64\n' +
          'node=present\n' +
          'npm=missing\n' +
          'git=present\n' +
          'aih=missing\n' +
          'repo=missing\n';
        processEmitter.stdout.emit('data', Buffer.from(mockProbeOutput));
        processEmitter.emit('close', 0);
      }, 10);

      return processEmitter;
    };

    const ctx = buildCtx('POST', '/v0/webui/ssh-connections/test', res);
    const handled = await handleWebUIRequest(ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.result.platform, 'Linux');
    assert.equal(data.result.arch, 'arm64');

    // 断言：临时私钥文件确实存在，且权限已严格被锁定为 0o600 (即 384)！
    assert.ok(detectedKeyPath);
    assert.equal(detectedKeyMode, 0o600);

    // 断言：退出后，该临时文件已被物理擦除、完全销毁！
    assert.equal(fs.existsSync(detectedKeyPath), false);
  }

  // ==========================================
  // 4. SSH 远程目录浏览器 API 接口测试
  // ==========================================
  {
    const res = createResCapture();
    requestBody = {
      connectionId: connId,
      subDir: '/root/app'
    };

    mockSpawn = (command, args, opts = {}) => {
      assert.equal(command, 'ssh');
      assert.ok(args[args.length - 1].endsWith('; true'));
      const processEmitter = new EventEmitter();
      processEmitter.stdout = new EventEmitter();
      processEmitter.stderr = new EventEmitter();
      processEmitter.stdin = { write: () => {}, end: () => {} };
      processEmitter.kill = () => {};

      setTimeout(() => {
        // 远程命令会首先输出当前目录（pwd），接下来每行是一个子文件夹名称
        const mockDirOutput =
          '/root/app\n' +
          'src\n' +
          'tests\n' +
          '.github\n' +
          '*\n'; // * 应被排除
        processEmitter.stdout.emit('data', Buffer.from(mockDirOutput));
        processEmitter.emit('close', 0);
      }, 10);

      return processEmitter;
    };

    const ctx = buildCtx('POST', '/v0/webui/ssh-hosts/browse', res);
    const handled = await handleWebUIRequest(ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.currentDir, '/root/app');
    assert.equal(data.parentDir, '/root');
    assert.equal(data.directories.length, 3);
    assert.deepEqual(data.directories[0], { name: '.github', path: '/root/app/.github' });
    assert.deepEqual(data.directories[1], { name: 'src', path: '/root/app/src' });
    assert.deepEqual(data.directories[2], { name: 'tests', path: '/root/app/tests' });
  }

  // ==========================================
  // 5. 级联删除验证测试
  // ==========================================
  {
    const res = createResCapture();
    const ctx = buildCtx('DELETE', `/v0/webui/ssh-connections/${connId}`, res);
    const handled = await handleWebUIRequest(ctx);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);

    // 5.1 验证：连接在 DB 中已被移除
    const savedConns = readJsonValue(fs, aiHomeDir, 'ssh_connections');
    assert.deepEqual(savedConns, []);

    // 5.2 验证：由于级联删除，关联的工作空间也被自动清空！
    const savedWorkspaces = readJsonValue(fs, aiHomeDir, 'ssh_workspaces');
    assert.deepEqual(savedWorkspaces, []);
  }
});
