'use strict';

// 出口连通性探测的中性目标：无凭据的 204 地址，不调用任何 provider 接口。
// 账号出口保存时的探测（lib/server/zcode-egress-probe.js）与出口池节点的恢复探测
// （egress-pool-runtime 的 probeNode）共用这一个地址。
const DEFAULT_PROXY_PROBE_URL = 'https://www.gstatic.com/generate_204';

module.exports = { DEFAULT_PROXY_PROBE_URL };
