import type { EdgeApplyResult, EdgeNginxMode, EdgeProvider } from './types';

/**
 * 入口转发面板的纯展示逻辑（与页面状态无关，可独立测试）。
 * 这里只做「把服务端返回翻译成人能读的」——不重新判断环境、不假设装了什么。
 */

export interface EdgeProviderMeta {
  label: string;
  /** 一句话说清它在这套体系里干什么。 */
  role: string;
  capability: string;
}

export const EDGE_PROVIDER_META: Record<EdgeProvider, EdgeProviderMeta> = {
  nginx: {
    label: 'nginx',
    role: '一个端口同时装 HTTPS(WebUI) + SOCKS5 代理 + UDP',
    capability: '四层分流（TLS 与 SOCKS5 看法不同，靠首字节区分）+ 应用层反代'
  },
  caddy: {
    label: 'Caddy',
    role: '给 WebUI 上 HTTPS（证书自动申请）',
    capability: '只有应用层反代：SOCKS5 上不来'
  },
  frp: {
    label: 'frp',
    role: '把 AIH 转发到有公网 IP 的 VPS（内网 / NAT 后面）',
    capability: '内网穿透：TCP + UDP 各一条转发行'
  }
};

export const EDGE_NGINX_MODES: Array<{ value: EdgeNginxMode; label: string; detail: string }> = [
  {
    value: 'split',
    label: '分流（推荐）',
    detail: '443 一个端口：TLS 给 WebUI，其余按首字节分给 SOCKS5；443/UDP 透传给中转'
  },
  { value: 'passthrough', label: '纯透传', detail: '443 全部转给 AIH：SOCKS5 与 UDP 都能用，但 WebUI 只能 http' },
  { value: 'http-only', label: '仅 HTTPS 反代', detail: '只给 WebUI 上证书，代理不上这个端口' }
];

/** 界面不再贴安装命令：装/更新/卸载都走受管工具的插件化生命周期（见 tool-plugins）。 */

/** 误差码 → 人话 + 该怎么办（服务端只给机器码，文案在这里收口）。 */
export function describeEdgeError(error: string | undefined, platform = ''): string {
  switch (String(error || '')) {
    case 'edge_provider_not_installed':
      return '本机没装这个软件：先按上面的线索装好再回来';
    case 'edge_config_not_found':
      return '没找到它的配置文件：确认软件装好后至少跑过一次';
    case 'edge_config_not_writable':
      return platform === 'win32'
        ? '目标配置不可写：用管理员身份重跑 AIH 服务'
        : '目标配置不可写：配置目录属 root，请在终端用 sudo 执行同一条 apply（服务进程不替你提权）';
    case 'edge_config_rejected':
      return '内核拒绝了这份配置，已整体回滚到改动前（下面是内核原话）';
    case 'edge_apply_busy':
      return '上一次写入还在校验，等几秒再试';
    case 'edge_domain_required':
      return '先填域名：客户端条目与证书都按它生成';
    case 'edge_remote_port_required':
      return '先填远端端口：VPS 上放行的那个';
    case 'edge_invalid_mode':
      return '不支持的 nginx 形态';
    case 'edge_unknown_provider':
      return '未知的转发软件';
    default:
      return String(error || '未知错误');
  }
}

export interface EdgeResultLine {
  tone: 'success' | 'error';
  text: string;
  detail: string;
}

/** apply 结果 → 一行结论 + 一行细节（写了哪些文件、怎么重载的）。 */
export function describeApplyResult(result: EdgeApplyResult): EdgeResultLine {
  if (!result || result.ok !== true) {
    return {
      tone: 'error',
      text: describeEdgeError(result && result.error),
      detail: String((result && (result.detail || result.message)) || '')
    };
  }
  const written = (result.files || [])
    .filter((file) => file.path)
    .map((file) => `${file.existed ? '改写' : '新建'} ${file.path}${file.backupPath ? `（备份 ${file.backupPath}）` : ''}`);
  if (result.configPath) written.push(`写入 ${result.configPath}${result.backupPath ? `（备份 ${result.backupPath}）` : ''}`);
  const reload = result.reloaded
    ? `已重载（${result.reloadedVia || 'service'}）`
    : `未重载${result.hint ? `：${result.hint}` : ''}`;
  return {
    tone: 'success',
    text: `${String(result.summary || '已写入')}，${reload}`,
    detail: written.join('；')
  };
}
