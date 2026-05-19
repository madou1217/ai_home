'use strict';

const path = require('node:path');

// 一些安全目录的校验，防止利用绝对路径乱读文件
function isSubPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function handleReadFileRequest(ctx) {
  const { url, writeJson, deps, aiHomeDir } = ctx;
  const { fs } = deps;

  try {
    let rawFilePath = String(url.searchParams?.get('path') || '').trim();
    let projectDir = String(url.searchParams?.get('projectPath') || '').trim();

    if (!rawFilePath) {
      writeJson(ctx.res, 400, { ok: false, error: 'path_required', message: '必须提供文件路径' });
      return true;
    }

    // 处理类似 .php:14 的行号后缀
    const lineNumMatch = rawFilePath.match(/^(.*?):[0-9]+(-[0-9]+)?$/);
    if (lineNumMatch) {
      rawFilePath = lineNumMatch[1];
    }

    // 将 ~ 解析到用户主目录
    if (rawFilePath.startsWith('~')) {
      const homeDir = typeof require('node:os').homedir === 'function'
        ? require('node:os').homedir()
        : process.env.HOME || process.env.USERPROFILE || '';
      rawFilePath = path.join(homeDir, rawFilePath.slice(1));
    }

    // 清理路径中的相对导航符，并转成绝对路径
    let targetPath = path.resolve(rawFilePath);

    // 【安全拦截1】绝不允许读取核心密钥文件
    const lowerPath = targetPath.toLowerCase();
    if (
      lowerPath.includes('/.ssh/') ||
      lowerPath.includes('\\.ssh\\') ||
      lowerPath.includes('auth.json') ||
      lowerPath.includes('oauth_creds.json') ||
      lowerPath.includes('credentials.json') ||
      lowerPath.endsWith('id_rsa')
    ) {
       writeJson(ctx.res, 403, { ok: false, error: 'permission_denied', message: '出于安全考虑，不允许读取此系统或凭证文件' });
       return true;
    }

    // 【安全拦截2】基于工作空间和 AI Home 的作用域白名单
    const effectiveAiHome = String((ctx.deps && ctx.deps.aiHomeDir) || aiHomeDir || '').trim();
    let isAuthorized = false;

    if (projectDir && isSubPath(projectDir, targetPath)) {
       isAuthorized = true;
    } else if (effectiveAiHome && isSubPath(effectiveAiHome, targetPath)) {
       isAuthorized = true;
    } else if (projectDir === targetPath || effectiveAiHome === targetPath) {
       isAuthorized = true; // allow reading the root directory itself (though it's a dir, stat will catch it)
    }

    // 为了兼容绝对路径引用和 VSCode server 类似的行为，如果没有 projectDir 上下文，我们只能拒绝读取。
    // 但是对于某些公共配置文件（比如 .ai_home 下的文件），始终放行。
    if (!isAuthorized) {
       writeJson(ctx.res, 403, { ok: false, error: 'outside_workspace', message: '出于安全考虑，只允许读取当前项目空间和 AI 配置目录内的文件' });
       return true;
    }

    if (!fs.existsSync(targetPath)) {
      writeJson(ctx.res, 404, { ok: false, error: 'not_found', message: `文件不存在: ${rawFilePath}` });
      return true;
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
       writeJson(ctx.res, 400, { ok: false, error: 'not_a_file', message: '目标路径不是一个普通文件' });
       return true;
    }

    // 【安全拦截3】文件大小限制 (最大 5MB)
    if (stat.size > 5 * 1024 * 1024) {
      writeJson(ctx.res, 413, { ok: false, error: 'file_too_large', message: '文件超过5MB大小限制' });
      return true;
    }

    const content = fs.readFileSync(targetPath, 'utf8');

    writeJson(ctx.res, 200, {
      ok: true,
      path: targetPath,
      content,
      size: stat.size,
      mtime: stat.mtimeMs
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'read_file_failed',
      message: String((error && error.message) || error || '读取文件失败')
    });
    return true;
  }
}

module.exports = {
  handleReadFileRequest
};
