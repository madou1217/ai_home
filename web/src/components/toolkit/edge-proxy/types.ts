/**
 * 本机入口转发（nginx / caddy / frp）的 WebUI 契约：字段与服务端
 * `lib/server/webui-edge-proxy-routes.js` 的返回一一对应。
 */

export type EdgeProvider = 'nginx' | 'caddy' | 'frp';
export type EdgeNginxMode = 'split' | 'passthrough' | 'http-only';

export interface EdgeFrpProxy {
  name: string;
  type: string;
  localPort?: number;
  remotePort?: number;
}

export interface EdgeProviderStatus {
  installed: boolean;
  binary?: string;
  version?: string;
  /** caddy / frp：配置文件路径；可写性按它判定。 */
  configPath?: string;
  /** nginx：配置目录（片段与 conf.d 都写在这下面）。 */
  configDir?: string;
  writable?: boolean;
  /** frp：配置里现有的转发条目（AIH 只动自己那两条）。 */
  proxies?: EdgeFrpProxy[];
}

export interface EdgeStatus {
  ok: boolean;
  platform: string;
  /** 转发目标：就是 AIH 自己监听的端口（默认跟随，不另开端口）。 */
  aihPort: number;
  providers: Record<EdgeProvider, EdgeProviderStatus>;
}

export interface EdgePlanFile {
  path: string;
  content: string;
  /** nginx：必须 include 到 nginx.conf 顶层（stream 段不能挂在 http{} 里）。 */
  topLevel?: boolean;
  /** caddy：往已有配置追加受管块，而不是覆盖整份文件。 */
  append?: boolean;
}

export interface EdgePlan {
  kind: EdgeProvider;
  summary: string;
  notes: string[];
  domain?: string;
  mode?: string;
  files: EdgePlanFile[];
  entries?: Array<{ name: string; type: string; localPort: number; remotePort: number }>;
}

export interface EdgeWrittenFile {
  path: string;
  backupPath?: string;
  existed?: boolean;
}

export interface EdgeApplyResult {
  ok: boolean;
  error?: string;
  message?: string;
  provider?: EdgeProvider;
  summary?: string;
  detail?: string;
  hint?: string;
  configPath?: string;
  backupPath?: string;
  files?: EdgeWrittenFile[];
  entries?: Array<{ name: string; type: string; localPort: number; remotePort: number }>;
  reloaded?: boolean;
  reloadedVia?: string;
}
