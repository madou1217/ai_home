'use strict';

// 一键导入：各客户端的深链接（URL Scheme）模板，依据各客户端源码 / 官方文档（2026-10-12 调研）。
// verified=false 的写法只见于第三方面板，界面上标「待实测」。
// format 为空的客户端由服务端按它拉取时的 UA 选格式：Hiddify / Karing / Husi 的输出取决于内核版本。
// download=true：没有导入链接，下载托管配置文件后用客户端打开（Surge Mac 只登记了 .conf 文档类型）。

const enc = encodeURIComponent;

const IMPORT_TARGETS = Object.freeze([
  {
    id: 'clash',
    name: 'Clash 系',
    apps: 'Clash Verge Rev、FlClash、Clash Party、Clash Meta for Android、Clash Nyanpasu、ClashX Meta',
    scheme: 'clash',
    format: 'mihomo',
    devices: ['desktop', 'mobile'],
    verified: true,
    // Clash Verge Rev 把 url= 之后的整段当地址，name 必须写在前面。
    build: ({ url, name }) => `clash://install-config?name=${enc(name)}&url=${enc(url)}`
  },
  {
    id: 'stash',
    name: 'Stash',
    scheme: 'stash',
    format: 'stash',
    devices: ['desktop', 'mobile'],
    verified: true,
    build: ({ url }) => `stash://install-config?url=${enc(url)}`
  },
  {
    id: 'sing-box',
    name: 'sing-box',
    apps: 'SFA / SFI / SFM（Husi、Hiddify 也认这个链接）',
    scheme: 'sing-box',
    format: 'sing-box',
    devices: ['desktop', 'mobile'],
    verified: true,
    build: ({ url, name }) => `sing-box://import-remote-profile?url=${enc(url)}#${enc(name)}`
  },
  {
    id: 'hiddify',
    name: 'Hiddify',
    scheme: 'hiddify',
    format: '',
    devices: ['desktop', 'mobile'],
    verified: true,
    build: ({ url, name }) => `hiddify://install-config?url=${enc(url)}&name=${enc(name)}`
  },
  {
    id: 'karing',
    name: 'Karing',
    scheme: 'karing',
    format: '',
    devices: ['desktop', 'mobile'],
    verified: true,
    build: ({ url, name }) => `karing://install-config?url=${enc(url)}&name=${enc(name)}`
  },
  {
    id: 'surge',
    name: 'Surge（iOS）',
    scheme: 'surge',
    format: 'surge',
    devices: ['mobile'],
    verified: true,
    build: ({ url }) => `surge:///install-config?url=${enc(url)}`
  },
  {
    id: 'surge-mac',
    name: 'Surge（Mac）',
    scheme: '',
    format: 'surge',
    devices: ['desktop'],
    verified: true,
    download: true,
    note: 'Surge Mac 没有导入链接：下载托管配置后用 Surge 打开，之后按订阅自动更新',
    build: null
  },
  {
    id: 'shadowrocket',
    name: 'Shadowrocket',
    scheme: 'shadowrocket',
    format: 'base64',
    devices: ['mobile'],
    verified: false,
    build: ({ url, name }) => `shadowrocket://add/sub://${Buffer.from(url, 'utf8').toString('base64')}?remark=${enc(name)}`
  },
  {
    id: 'loon',
    name: 'Loon',
    scheme: 'loon',
    format: 'loon',
    devices: ['mobile'],
    verified: true,
    build: ({ url }) => `loon://import?sub=${enc(url)}`
  },
  {
    id: 'quantumult-x',
    name: 'Quantumult X',
    scheme: 'quantumult-x',
    format: 'quantumult-x',
    view: 'nodes',
    devices: ['mobile'],
    verified: true,
    note: '只能添加节点订阅；完整配置请在 QX 里用「下载配置」填订阅地址',
    build: ({ url, name }) => `quantumult-x:///add-resource?remote-resource=${enc(JSON.stringify({ server_remote: [`${url}, tag=${name}`] }))}`
  },
  {
    id: 'egern',
    name: 'Egern',
    scheme: 'egern',
    format: 'egern',
    devices: ['mobile'],
    verified: true,
    build: ({ url, name }) => `egern:/profiles/new?name=${enc(name)}&url=${enc(url)}`
  },
  {
    id: 'surfboard',
    name: 'Surfboard',
    scheme: 'surfboard',
    format: 'surfboard',
    devices: ['mobile'],
    verified: true,
    build: ({ url }) => `surfboard:///install-config?url=${enc(url)}`
  },
  {
    id: 'nekobox',
    name: 'NekoBox',
    scheme: 'sn',
    format: 'mihomo',
    devices: ['mobile'],
    verified: true,
    build: ({ url, name }) => `sn://subscription?url=${enc(url)}&name=${enc(name)}`
  },
  {
    id: 'husi',
    name: 'Husi',
    scheme: 'husi',
    format: '',
    devices: ['mobile'],
    verified: true,
    build: ({ url, name }) => `husi://subscription?url=${enc(url)}&name=${enc(name)}`
  },
  {
    id: 'v2rayng',
    name: 'v2rayNG',
    scheme: 'v2rayng',
    format: 'base64',
    devices: ['mobile'],
    verified: true,
    // v2rayNG 会把参数解码两次；订阅 token 是 base64url，不含 + 与 %，解两次仍是原地址。
    build: ({ url, name }) => `v2rayng://install-config?url=${enc(url)}#${enc(name)}`
  },
  {
    id: 'happ',
    name: 'Happ',
    scheme: 'happ',
    format: 'base64',
    devices: ['mobile'],
    verified: false,
    build: ({ url }) => `happ://add/${url}`
  },
  {
    id: 'streisand',
    name: 'Streisand',
    scheme: 'streisand',
    format: 'base64',
    devices: ['mobile'],
    verified: false,
    build: ({ url, name }) => `streisand://import/${url}#${enc(name)}`
  },
  {
    id: 'v2box',
    name: 'V2Box',
    scheme: 'v2box',
    format: 'base64',
    devices: ['mobile'],
    verified: false,
    build: ({ url, name }) => `v2box://install-sub?url=${enc(url)}&name=${enc(name)}`
  },
  {
    id: 'v2rayn',
    name: 'v2rayN',
    scheme: '',
    format: 'base64',
    devices: ['desktop'],
    verified: true,
    note: 'v2rayN 没有 URL Scheme：复制订阅地址后在「订阅分组」里添加',
    build: null
  }
]);

/** 只接受 http(s)://host[:port]（不带路径），其它返回 ''。 */
function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_error) {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.host) return '';
  if (url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) return '';
  return `${url.protocol}//${url.host}`;
}

function subscriptionUrl(base, format, view) {
  const params = new URLSearchParams();
  if (format) params.set('target', format);
  if (view) params.set('view', view);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * 某个聚合订阅在指定 origin 下的导入方式：通用地址（按 UA 自动选格式）与每个客户端的深链接。
 * origin 不合法时返回 null。
 */
function buildImportLinks({ origin, token, name }) {
  const base = normalizeOrigin(origin);
  if (!base || !token) return null;
  const subscriptionBase = `${base}/sub/${token}`;
  const profileName = String(name || '聚合订阅');
  return {
    origin: base,
    url: subscriptionBase,
    clients: IMPORT_TARGETS.map((target) => {
      const url = subscriptionUrl(subscriptionBase, target.format, target.view);
      return {
        id: target.id,
        name: target.name,
        apps: target.apps || '',
        scheme: target.scheme,
        format: target.format,
        view: target.view || '',
        devices: target.devices,
        verified: target.verified,
        download: target.download === true,
        note: target.note || '',
        url,
        link: target.build ? target.build({ url, name: profileName }) : ''
      };
    })
  };
}

/** 本机安装检测要查的 URL Scheme。 */
function importSchemes() {
  return [...new Set(IMPORT_TARGETS.map((target) => target.scheme).filter(Boolean))];
}

module.exports = {
  IMPORT_TARGETS,
  buildImportLinks,
  importSchemes,
  normalizeOrigin
};
