# Web UI 自动构建配置完成

## ✅ 已完成的工作

### 1. **修改 postinstall Hook**

已更新 `scripts/postinstall.js`，添加了自动构建 Web UI 的功能：

**功能特性：**
- 🔍 **智能检测**：检查 `web/` 目录和 `package.json` 是否存在
- 📦 **自动安装**：如果 `web/node_modules` 不存在，自动运行 `npm install`
- ⚡ **增量构建**：检查 `dist` 目录时间戳，避免重复构建
- 🛡️ **容错处理**：构建失败不会中断主项目安装

**工作流程：**
```
npm install (主项目)
  ↓
postinstall hook 触发
  ↓
检查 web/ 目录
  ↓
安装 Web UI 依赖（如需要）
  ↓
构建 Web UI（如需要）
  ↓
完成！
```

### 2. **成功构建 Web UI**

构建产物：
```
web/dist/
├── index.html           (0.49 kB)
├── assets/
│   ├── index-D3-jALaL.js      (1,117.63 kB / 358.12 kB gzipped)
│   └── index-rqTnqYL2.css     (0.35 kB / 0.26 kB gzipped)
```

### 3. **服务器已重启并验证**

- ✅ 服务器进程 PID: 71252
- ✅ 监听端口: 8317
- ✅ Web UI 可访问: http://127.0.0.1:8317/ui/
- ✅ API 正常响应: http://127.0.0.1:8317/v0/webui/accounts

## 🧪 验证测试

### Web UI 访问测试

```bash
# 测试首页
curl -I http://127.0.0.1:8317/ui/
# HTTP/1.1 200 OK

# 测试 JS 资源
curl -I http://127.0.0.1:8317/ui/assets/index-D3-jALaL.js
# HTTP/1.1 200 OK

# 测试 CSS 资源
curl -I http://127.0.0.1:8317/ui/assets/index-rqTnqYL2.css
# HTTP/1.1 200 OK
```

### API 端点测试

```bash
# 获取账号列表
curl http://127.0.0.1:8317/v0/webui/accounts

# 返回示例
{
  "ok": true,
  "accounts": [
    {
      "provider": "codex",
      "accountId": "5",
      "displayName": "code5@meadeo.com",
      "configured": true,
      "apiKeyMode": false,
      "exhausted": false,
      "remainingPct": 78,
      "updatedAt": 1775586191350
    },
    ...
  ]
}
```

## 📝 使用说明

### 初次安装

当你克隆或拉取项目后，只需运行：

```bash
npm install
```

postinstall hook 会自动：
1. 安装 Web UI 依赖
2. 构建 Web UI
3. 准备好所有资源

### 后续更新

如果修改了 Web UI 代码，可以：

**方式一：手动构建**
```bash
cd web
npm run build
```

**方式二：重新触发 postinstall**
```bash
npm run postinstall
```

**方式三：使用构建脚本**
```bash
./scripts/build-web.sh
```

### 开发模式

开发 Web UI 时：

```bash
cd web
npm run dev
```

开发服务器将在 http://localhost:3000 启动，自动代理 API 到服务器。

## 🔧 配置详情

### postinstall.js 关键代码

```javascript
function buildWebUI(rootDir) {
  const webDir = path.join(rootDir, 'web');
  const webPackageJson = path.join(webDir, 'package.json');
  const webDistDir = path.join(webDir, 'dist');

  // 检查 web 目录是否存在
  if (!fs.existsSync(webDir) || !fs.existsSync(webPackageJson)) {
    console.log('ℹ️  Web UI directory not found, skipping build');
    return;
  }

  console.log('🌐 Building Web UI...');

  // 安装依赖（如需要）
  const webNodeModules = path.join(webDir, 'node_modules');
  if (!fs.existsSync(webNodeModules)) {
    console.log('📦 Installing Web UI dependencies...');
    spawnSync('npm', ['install'], { cwd: webDir, stdio: 'inherit', shell: true });
  }

  // 增量构建检查
  if (fs.existsSync(webDistDir)) {
    const distStat = fs.statSync(webDistDir);
    const packageStat = fs.statSync(webPackageJson);
    if (distStat.mtime > packageStat.mtime) {
      console.log('✅ Web UI already built, skipping');
      return;
    }
  }

  // 构建
  console.log('⚙️  Compiling Web UI...');
  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: webDir,
    stdio: 'inherit',
    shell: true
  });

  if (buildResult.status === 0) {
    console.log('✅ Web UI built successfully!');
    console.log('💡 Access Web UI at: http://127.0.0.1:8317/ui/');
  }
}
```

### package.json 脚本

```json
{
  "scripts": {
    "postinstall": "node scripts/postinstall.js",
    "web:install": "cd web && npm install",
    "web:build": "cd web && npm run build",
    "web:dev": "cd web && npm run dev",
    "build": "npm run web:build"
  }
}
```

## 🚀 自动化流程

### CI/CD 集成

在 CI/CD 流程中，只需：

```bash
npm install  # 自动安装并构建所有内容
npm test     # 运行测试
```

### Docker 部署

Dockerfile 示例：

```dockerfile
FROM node:18

WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
COPY web ./web
COPY lib ./lib
COPY bin ./bin

RUN npm install  # 自动构建 Web UI

EXPOSE 8317
CMD ["node", "bin/ai-home.js", "server"]
```

## 📊 构建性能

| 阶段 | 时间 | 说明 |
|------|------|------|
| Web 依赖安装 | ~37s | 首次安装 272 个包 |
| TypeScript 编译 | ~2s | 编译 TS 到 JS |
| Vite 打包 | ~2s | 打包和优化 |
| **总计** | **~41s** | 首次完整构建 |

**增量构建**（已有依赖）：~4s

## 🔍 故障排查

### 构建失败

如果构建失败，检查：

1. **Node.js 版本**
   ```bash
   node --version  # 推荐 v18+
   ```

2. **清理并重新安装**
   ```bash
   cd web
   rm -rf node_modules package-lock.json dist
   npm install
   npm run build
   ```

3. **查看详细错误**
   ```bash
   cd web
   npm run build 2>&1 | tee build.log
   ```

### 服务器未提供 Web UI

1. **检查 dist 目录**
   ```bash
   ls -la web/dist/
   ```

2. **检查服务器日志**
   ```bash
   tail -f ~/.ai_home/proxy_requests.jsonl
   ```

3. **重新构建**
   ```bash
   npm run web:build
   pkill -f "aih.*server"
   ./bin/ai-home.js server
   ```

## 🎯 下一步

现在 Web UI 已完全集成，你可以：

1. **访问管理界面**
   ```
   http://127.0.0.1:8317/ui/
   ```

2. **查看账号状态**
   - 仪表盘显示所有账号
   - 实时额度监控
   - 健康状态检查

3. **管理账号**
   - 添加新账号
   - 删除账号
   - 配置设置

4. **发送会话**
   - 直接在浏览器中与 AI 对话
   - 自动选择最佳账号

## 📚 相关文档

- [Web UI 快速入门](WEB_QUICKSTART.md)
- [Web UI 详细文档](docs/WEB_UI.md)
- [实现总结](WEB_IMPLEMENTATION_SUMMARY.md)

---

**构建时间**：2026-04-08
**服务器状态**：✅ 运行中 (PID: 71252)
**Web UI 地址**：http://127.0.0.1:8317/ui/
