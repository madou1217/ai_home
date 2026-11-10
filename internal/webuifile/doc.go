// Package webuifile 是 WebUI 文件读取与目录浏览的访问策略核。
//
// 逐条对应 Node：
//   - lib/server/webui-file-access-policy.js（包含判定、信任候选、provider 配置/产物拒绝）
//   - lib/server/webui-project-root-policy.js（项目根登记、子路径越界）
//   - lib/server/webui-file-tree-routes.js 的策略部分（隐藏名、上限、条目形状）
//   - lib/server/webui-file-routes.js 的目标解析、大小上限、媒体类型与授权载荷
//
// 本包只做判定，不挂路由、不落盘：项目根由 ProjectRoots 提供；已信任目录用
// TrustedRoot 切片表达，读写 app-state 由宿主负责；provider 投影路径改写通过
// Env.CanonicalizeProviderPath 注入。provider 配置/私有产物拒绝与可读资源根
// 复用 internal/runtime/storagepolicy，避免同一份安全白名单出现两个真值。
//
// 已知非本包职责（Node-only 输入）：provider 投影映射与文本规范化、项目快照抓取、
// os.homedir() 兜底；目录名排序在 Node 用 localeCompare，这里是字节序。
package webuifile
