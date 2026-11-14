// Package routeownership 定义 Node 公开宿主与 Go Core 之间的路由归属表。
//
// 这里是唯一人工维护的定义源：Go 侧生成跨端投影，Node 的 go-core 转发器与
// build stamp 读取生成结果。迁移一个条目时只改本文件并重新生成。
package routeownership

//go:generate go run ../../cmd/route-ownership-manifest --root ../..

// SchemaVersion 是投影格式版本。
const SchemaVersion = 1

// Route 描述一条公开路由；Methods 为空表示不限制方法。
//
// Pattern/Upgrade/Role 是旧 manifest 的原始字段：build stamp 会对整条路由取
// 摘要，保留它们才能让已编译的 Go 二进制在升级 Node 后继续通过校验。
type Route struct {
	Transport string   `json:"transport"`
	Methods   []string `json:"methods,omitempty"`
	Path      string   `json:"path"`
	Pattern   string   `json:"pattern,omitempty"`
	Upgrade   bool     `json:"upgrade,omitempty"`
	Role      string   `json:"role,omitempty"`
}

// Entry 描述一个路由条目的归属与两端实现。
type Entry struct {
	ID              string  `json:"id"`
	ProductionOwner string  `json:"production_owner"`
	MigrationState  string  `json:"migration_state"`
	GoRoutes        []Route `json:"go_routes,omitempty"`
	NodeRoutes      []Route `json:"node_routes,omitempty"`
}

// Manifest 是 Node 与 Go 共用的路由归属投影。
type Manifest struct {
	SchemaVersion int     `json:"schema_version"`
	GeneratedFrom string  `json:"generated_from"`
	Entries       []Entry `json:"entries"`
}

func httpRoute(methods []string, path string) Route {
	return Route{Transport: "http", Methods: methods, Path: path}
}

func websocketRoute(path string) Route {
	return Route{Transport: "websocket", Methods: []string{"GET"}, Path: path, Upgrade: true}
}

// Current 返回当前路由归属表。
//
// 健康检查与 WebUI 表面由 Node 公开宿主调度；App Server 与全部 /v1 数据面
// 条目已经 go_owned。两个 go.preview 条目保留 node_owned，避免预览路由
// 被误当成正式切流结果。
func Current() Manifest {
	return Manifest{
		SchemaVersion: SchemaVersion,
		GeneratedFrom: "contracts/routeownership/contract.go",
		Entries: []Entry{
			{
				ID:              "gateway.health",
				ProductionOwner: "node",
				MigrationState:  "node_owned",
				GoRoutes:        []Route{httpRoute([]string{"GET", "HEAD"}, "/healthz")},
				NodeRoutes:      []Route{httpRoute([]string{"GET"}, "/healthz")},
			},
			{
				ID:              "gateway.readiness",
				ProductionOwner: "node",
				MigrationState:  "node_owned",
				GoRoutes:        []Route{httpRoute([]string{"GET", "HEAD"}, "/readyz")},
				NodeRoutes:      []Route{httpRoute([]string{"GET"}, "/readyz")},
			},
			{
				ID:              "gateway.models.list",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"GET", "HEAD"}, "/v1/models")},
				NodeRoutes:      []Route{httpRoute([]string{"GET"}, "/v1/models")},
			},
			{
				ID:              "gateway.models.detail",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{{
					Transport: "http", Methods: []string{"GET", "HEAD"}, Path: "/v1/models/{id}",
					Pattern: "^/v1/models/([^/]+)$",
				}},
				NodeRoutes: []Route{{
					Transport: "http", Methods: []string{"GET"}, Path: "/v1/models/{id}",
					Pattern: "^/v1/models/([^/]+)$",
				}},
			},
			{
				ID:              "gateway.props",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"GET"}, "/v1/props")},
				NodeRoutes:      []Route{httpRoute([]string{"GET"}, "/v1/props")},
			},
			{
				ID:              "gateway.openai.responses",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"POST"}, "/v1/responses")},
				NodeRoutes:      []Route{httpRoute([]string{"POST"}, "/v1/responses")},
			},
			{
				ID:              "gateway.openai.responses.websocket",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{websocketRoute("/v1/responses")},
				NodeRoutes:      []Route{websocketRoute("/v1/responses")},
			},
			{
				ID:              "gateway.openai.chat_completions",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"POST"}, "/v1/chat/completions")},
				NodeRoutes:      []Route{httpRoute([]string{"POST"}, "/v1/chat/completions")},
			},
			{
				ID:              "gateway.anthropic.messages",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"POST"}, "/v1/messages")},
				NodeRoutes:      []Route{httpRoute([]string{"POST"}, "/v1/messages")},
			},
			{
				ID:              "gateway.anthropic.count_tokens",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"POST"}, "/v1/messages/count_tokens")},
				NodeRoutes:      []Route{httpRoute([]string{"POST"}, "/v1/messages/count_tokens")},
			},
			{
				ID:              "gateway.gemini.generate_content",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{{
					Transport: "http", Methods: []string{"POST"}, Path: "/v1{beta?}/models/{model}:generateContent",
					Pattern: "^/v1(?:beta)?/models/([^/:]+):generateContent$",
				}},
				NodeRoutes: []Route{{
					Transport: "http", Methods: []string{"POST"}, Path: "/v1{beta?}/models/{model}:generateContent",
					Pattern: "^/v1(?:beta)?/models/[^/]*:generateContent$",
				}},
			},
			{
				ID:              "gateway.gemini.stream_generate_content",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{{
					Transport: "http", Methods: []string{"POST"}, Path: "/v1{beta?}/models/{model}:streamGenerateContent",
					Pattern: "^/v1(?:beta)?/models/([^/:]+):streamGenerateContent$",
				}},
				NodeRoutes: []Route{{
					Transport: "http", Methods: []string{"POST"}, Path: "/v1{beta?}/models/{model}:streamGenerateContent",
					Pattern: "^/v1(?:beta)?/models/[^/]*:streamGenerateContent$",
				}},
			},
			{
				ID:              "gateway.images.generations",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"POST"}, "/v1/images/generations")},
				NodeRoutes:      []Route{httpRoute([]string{"POST"}, "/v1/images/generations")},
			},
			{
				ID:              "gateway.images.edits",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes:        []Route{httpRoute([]string{"POST"}, "/v1/images/edits")},
				NodeRoutes:      []Route{httpRoute([]string{"POST"}, "/v1/images/edits")},
			},
			{
				ID:              "gateway.vision.blobs",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{{
					Transport: "http", Methods: []string{"GET"}, Path: "/v1/blobs/{id}", Pattern: "/v1/blobs/*",
				}},
				NodeRoutes: []Route{{
					Transport: "http", Methods: []string{"GET"}, Path: "/v1/blobs/{id}", Pattern: "/v1/blobs/*",
				}},
			},
			{
				ID:              "node.webui_and_session_surface",
				ProductionOwner: "node",
				MigrationState:  "node_owned",
				NodeRoutes: []Route{
					// 真实剩余面：2026-11-14 用「无凭据探测公开口」逐个分类得到，
					// 其余 /v0/webui 家族已由 Go 承接（见各自 go_owned 条目）。
					httpRoute([]string{"*"}, "/v0/webui/accounts/plugin-login/start"),
					httpRoute([]string{"*"}, "/v0/webui/accounts/zcode/url-callback"),
					httpRoute([]string{"*"}, "/v0/webui/chat/artifacts"),
					httpRoute([]string{"*"}, "/v0/webui/chat/attachments"),
					httpRoute([]string{"*"}, "/v0/webui/chat/sessions"),
					httpRoute([]string{"*"}, "/v0/webui/internal/remote-tools"),
					httpRoute([]string{"*"}, "/v0/webui/provider-cli-upgrade"),
					{Transport: "http", Methods: []string{"GET"}, Path: "/ui/*", Role: "static WebUI"},
				},
			},
			{
				ID:              "node.webui_image_studio",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/studio/image/models"),
					httpRoute([]string{"GET", "POST"}, "/v0/webui/studio/image/sessions"),
					httpRoute([]string{"DELETE", "GET", "PATCH"}, "/v0/webui/studio/image/sessions/{sessionId}"),
					httpRoute([]string{"POST"}, "/v0/webui/studio/image/sessions/{sessionId}/runs"),
					httpRoute([]string{"GET"}, "/v0/webui/studio/image/sessions/{sessionId}/assets/{assetId}"),
				},
				NodeRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/studio/image/models"),
					httpRoute([]string{"GET", "POST"}, "/v0/webui/studio/image/sessions"),
					httpRoute([]string{"DELETE", "GET", "PATCH"}, "/v0/webui/studio/image/sessions/{sessionId}"),
					httpRoute([]string{"POST"}, "/v0/webui/studio/image/sessions/{sessionId}/runs"),
					httpRoute([]string{"GET"}, "/v0/webui/studio/image/sessions/{sessionId}/assets/{assetId}"),
				},
			},
			{
				// AI 翻译页：浏览器数据面已由 Go 的同一处理器接住（前缀重写）。
				ID:              "webui.translation_studio",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/translation/settings"),
					httpRoute([]string{"POST"}, "/v0/webui/translation/settings"),
					httpRoute([]string{"GET"}, "/v0/webui/translation/providers"),
					httpRoute([]string{"POST"}, "/v0/webui/translation/providers"),
					httpRoute([]string{"GET"}, "/v0/webui/translation/languages"),
					httpRoute([]string{"POST"}, "/v0/webui/translation/detect"),
					httpRoute([]string{"GET"}, "/v0/webui/translation/models"),
					httpRoute([]string{"POST"}, "/v0/webui/translation/stream"),
				},
			},
			{
				// 路由权重诊断：浏览器入口由 Go 直接应答。
				ID:              "webui.routing_weights",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/routing/weights"),
				},
			},
			{
				// 账号结果汇总：浏览器入口由 Go 直接应答。
				ID:              "webui.account_outcomes",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/account-outcomes"),
				},
			},
			{
				// 账号别名池读写：浏览器入口由 Go 直接应答。
				ID:              "webui.account_alias_pool",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/alias-pool"),
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}/alias-pool"),
				},
			},
			{
				// 账号配置文件只读查看：浏览器入口由 Go 直接应答。
				ID:              "webui.account_config_files",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/config-files"),
				},
			},
			{
				// 账号模型上下文窗口读写：浏览器入口由 Go 直接应答。
				ID:              "webui.account_model_context",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/model-context"),
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}/model-context"),
					httpRoute([]string{"DELETE"}, "/v0/webui/accounts/{provider}/{accountRef}/model-context"),
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/model-context/bulk"),
				},
			},
			{
				// 聊天粘贴设置：浏览器入口由 Go 直接应答。
				ID:              "webui.chat_paste_settings",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/chat/paste-settings"),
					httpRoute([]string{"POST"}, "/v0/webui/chat/paste-settings"),
				},
			},
			{
				// 账号额度重置历史：浏览器入口（含 reset-history 别名）由 Go 直接应答。
				ID:              "webui.account_quota_reset",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/quota-reset-events"),
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/reset-history"),
				},
			},
			{
				// 项目目录树：浏览器入口由 Go 直接应答。
				ID:              "webui.fs_tree",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/fs/tree"),
				},
			},
			{
				// Git 只读摘要与差异：浏览器入口由 Go 直接应答。
				ID:              "webui.git_read",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/git/summary"),
					httpRoute([]string{"GET"}, "/v0/webui/git/diff"),
				},
			},
			{
				// 项目目录与工作区项目视图：浏览器入口由 Go 直接应答。
				ID:              "webui.projects",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/projects"),
					httpRoute([]string{"GET"}, "/v0/webui/projects/sessions"),
					httpRoute([]string{"GET"}, "/v0/webui/projects/watch"),
					httpRoute([]string{"POST"}, "/v0/webui/projects/snapshot"),
				},
			},
			{
				// 会话读取与生命周期（列表/归档/恢复）：浏览器入口由 Go 直接应答。
				ID:              "webui.sessions",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/sessions/{provider}/{accountRef}"),
					httpRoute([]string{"GET"}, "/v0/webui/sessions/lifecycle-capabilities"),
					httpRoute([]string{"GET"}, "/v0/webui/sessions/archived"),
					httpRoute([]string{"POST"}, "/v0/webui/sessions/archive"),
					httpRoute([]string{"POST"}, "/v0/webui/sessions/unarchive"),
				},
			},
			{
				// 上游错误映射组：浏览器入口由 Go 直接应答。
				ID:              "webui.upstream_error_mappings",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET", "POST"}, "/v0/webui/upstream-error-mappings"),
					httpRoute([]string{"GET", "PUT", "DELETE"}, "/v0/webui/upstream-error-mappings/{id}"),
					httpRoute([]string{"POST"}, "/v0/webui/upstream-error-mappings/{id}/toggle"),
				},
			},
			{
				// 模型别名：浏览器入口由 Go 直接应答（集合/成员/targets/replace/enabled/toggle）。
				ID:              "webui.model_aliases",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET", "POST"}, "/v0/webui/model-aliases"),
					httpRoute([]string{"PUT", "DELETE"}, "/v0/webui/model-aliases/{id}"),
					httpRoute([]string{"GET"}, "/v0/webui/model-aliases/targets"),
					httpRoute([]string{"POST"}, "/v0/webui/model-aliases/replace"),
					httpRoute([]string{"POST"}, "/v0/webui/model-aliases/{id}/enabled"),
					httpRoute([]string{"POST"}, "/v0/webui/model-aliases/{id}/toggle"),
				},
			},
			{
				// 应用安装：浏览器入口由 Go 直接应答。
				ID:              "webui.app_install",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/app-install"),
					httpRoute([]string{"GET"}, "/v0/webui/app-install/jobs"),
					httpRoute([]string{"GET"}, "/v0/webui/app-install/jobs/{jobId}"),
					httpRoute([]string{"POST"}, "/v0/webui/app-install/jobs/{jobId}/cancel"),
				},
			},
			{
				// 插件 provider hook 回环入口：由 Go 的 webuiauth 门承接。
				ID:              "webui.session_provider_hook",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/session-events/provider-hook"),
				},
			},
			{
				// 账号实时通道（SSE）：浏览器入口由 Go 直接应答，Node 事件经 publish 注入。
				ID:              "webui.accounts_watch",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/watch"),
					httpRoute([]string{"POST"}, "/v0/webui/accounts/watch/snapshot"),
				},
			},
			{
				// 账号列表（全量，浏览器入口）：由 Go 的实时列表直接应答。
				ID:              "webui.accounts_list",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts"),
					httpRoute([]string{"GET"}, "/v0/webui/accounts/live"),
				},
			},
			{
				// 本机账号发现：浏览器入口由 Go 直接应答。
				ID:              "webui.accounts_detect",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/accounts/detect"),
				},
			},
			{
				// 工具链镜像 / 代理 / 连通性：浏览器入口由 Go 直接应答。
				ID:              "webui.toolkit_settings",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/toolkit/mirrors"),
					httpRoute([]string{"POST"}, "/v0/webui/toolkit/mirrors/set"),
					httpRoute([]string{"POST"}, "/v0/webui/toolkit/mirrors/ping"),
					httpRoute([]string{"GET"}, "/v0/webui/toolkit/proxy"),
					httpRoute([]string{"POST"}, "/v0/webui/toolkit/proxy/set"),
					httpRoute([]string{"GET"}, "/v0/webui/toolkit/connectivity"),
					httpRoute([]string{"GET"}, "/v0/webui/toolkit/tools"),
					httpRoute([]string{"GET"}, "/v0/webui/toolkit/apps"),
					httpRoute([]string{"POST"}, "/v0/webui/toolkit/apps/install"),
					httpRoute([]string{"POST"}, "/v0/webui/toolkit/apps/plan"),
					httpRoute([]string{"POST"}, "/v0/webui/toolkit/apps/hooks"),
					httpRoute([]string{"GET", "PUT"}, "/v0/webui/toolkit/apps/{appId}/config"),
					httpRoute([]string{"GET", "POST"}, "/v0/webui/toolkit/tools/{toolId}/service"),
					httpRoute([]string{"PUT"}, "/v0/webui/toolkit/tools/{toolId}/service/settings"),
				},
			},
			{
				// 账号出口池运行时与分配：浏览器入口由 Go 直接应答。
				ID:              "webui.account_egress",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/egress-runtime"),
					httpRoute([]string{"PUT"}, "/v0/webui/accounts/{provider}/{accountRef}/egress-assignment"),
				},
			},
			{
				// 账号窗口激活设置与状态：浏览器入口由 Go 直接应答。
				ID:              "webui.account_window_activation",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/window-activation"),
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}/window-activation"),
				},
			},
			{
				// 账号导入作业：浏览器入口由 Go 直接应答。
				ID:              "webui.account_import",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/accounts/import"),
				},
			},
			{
				// 账号授权作业快照：新公开前缀（避开 accounts/{provider}/{accountRef} 冲突）。
				ID:              "webui.account_jobs",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/account-jobs/{jobId}"),
					httpRoute([]string{"POST"}, "/v0/webui/account-jobs/{jobId}/cancel"),
					httpRoute([]string{"POST"}, "/v0/webui/account-jobs/{jobId}/callback"),
					httpRoute([]string{"POST"}, "/v0/webui/account-jobs/{jobId}/install"),
					httpRoute([]string{"POST"}, "/v0/webui/account-jobs/{jobId}/local-import"),
				},
			},
			{
				// 账号编辑：浏览器入口由 Go 直接应答（ref 先经链接表翻译）。
				ID:              "webui.account_update",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}/update"),
				},
			},
			{
				// 账号删除：浏览器旧路径（POST 无后缀）由 Go 承接，ref 先翻译。
				ID:              "webui.account_delete",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}"),
				},
			},
			{
				// 账号重新认证：浏览器入口由 Go 承接，ref 先翻译。
				ID:              "webui.account_reauth",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}/reauth"),
				},
			},
			{
				// 账号用量对拍调试入口（必须带 ?source=go）。
				ID:              "webui.account_token_usage",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/{provider}/{accountRef}/token-usage"),
				},
			},
			{
				// 新增账号：浏览器入口由 Go 分流（OAuth 作业 / 静态入库）。
				ID:              "webui.account_add",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/accounts/add"),
				},
			},
			{
				// 账号刷新（模型/状态/额度）与仅额度刷新：浏览器入口由 Go 承接，ref 先翻译。
				ID:              "webui.account_refresh",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}/refresh"),
					httpRoute([]string{"POST"}, "/v0/webui/accounts/{provider}/{accountRef}/refresh-usage"),
				},
			},
			{
				// 宿主应用可用性（app-entries）：浏览器入口由 Go 探测，字段与 Node 一致。
				ID:              "webui.app_entries",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/app-entries"),
				},
			},
			{
				// 出口池 / 池组 / 节点：浏览器入口由 Go 直接应答（路径同构）。
				ID:              "webui.egress_pools",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"*"}, "/v0/webui/egress-pool"),
					httpRoute([]string{"*"}, "/v0/webui/egress-pools"),
					httpRoute([]string{"*"}, "/v0/webui/egress-pool-groups"),
				},
			},
			{
				// GeoIP 资源与任务：浏览器入口由 Go 直接应答。
				ID:              "webui.geo_resources",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/geo-resources"),
				},
			},
			{
				// peer 消息与 watch：浏览器入口由 Go 直接应答。
				ID:              "webui.peer_messages",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/peer/messages"),
				},
			},
			{
				// 计划任务（列表/预览/记录/动作）：浏览器入口由 Go 直接应答。
				ID:              "webui.scheduled_tasks",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET", "POST"}, "/v0/webui/scheduled-tasks"),
					httpRoute([]string{"POST"}, "/v0/webui/scheduled-tasks/preview"),
				},
			},
			{
				// 工作区文件读/信任：浏览器 fs/* 映射到 workspace/fs/*。
				ID:              "webui.workspace_fs",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/fs/access"),
					httpRoute([]string{"GET"}, "/v0/webui/fs/read"),
					httpRoute([]string{"GET"}, "/v0/webui/fs/media"),
					httpRoute([]string{"POST"}, "/v0/webui/fs/trust"),
				},
			},
			{
				// 工作区模型目录：浏览器 /v0/webui/models 映射到 workspace/models。
				ID:              "webui.workspace_models",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/models"),
				},
			},
			{
				// 服务配置 / 控制面 / 模型目录 / provider hooks / 账号导出与授权来源：
				// 浏览器入口由 Go 直接应答（与管理路径同构）。
				ID:              "webui.control_plane_surfaces",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/export"),
					httpRoute([]string{"GET"}, "/v0/webui/accounts/provider-auth-sources"),
				},
			},
			{
				// 本机审批桥 ingress（回环专用）。
				ID:              "webui.internal_approval",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"POST"}, "/v0/webui/internal/approval-request"),
				},
			},
			{
				// 账号活动参数与本机登录态导入：浏览器入口由 Go 直接应答。
				ID:              "webui.account_activity_params",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/accounts/activity/params"),
					httpRoute([]string{"POST"}, "/v0/webui/accounts/local-import"),
				},
			},
			{
				// 账号级上游错误规则只读视图：浏览器入口由 Go 直接应答。
				ID:              "webui.account_error_rules",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET"}, "/v0/webui/account-upstream-error-rules"),
				},
			},
			{
				// 聊天会话 CRUD：浏览器入口由 Go 直接应答。
				ID:              "webui.chat_sessions",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					httpRoute([]string{"GET", "POST"}, "/v0/webui/chat-sessions"),
				},
			},
			{
				ID:              "node.codex_app_server",
				ProductionOwner: "go",
				MigrationState:  "go_owned",
				GoRoutes: []Route{
					websocketRoute("/v0/codex/app-server"),
					{Transport: "websocket", Methods: []string{"GET"}, Path: "/", Upgrade: true, Role: "legacy app-server compatibility"},
				},
				NodeRoutes: []Route{
					websocketRoute("/v0/codex/app-server"),
					{Transport: "websocket", Methods: []string{"GET"}, Path: "/", Upgrade: true, Role: "legacy app-server compatibility"},
				},
			},
			{
				ID:              "go.preview.account_management",
				ProductionOwner: "node",
				MigrationState:  "node_owned",
				GoRoutes: []Route{{
					Transport: "http", Methods: []string{"*"}, Path: "/v1/management/*", Role: "explicit private Preview only",
				}},
				NodeRoutes: []Route{{
					Transport: "http", Methods: []string{"*"}, Path: "/v0/webui/management/*", Role: "formal Node WebUI facade",
				}},
			},
			{
				ID:              "go.preview.claude_relay_leases",
				ProductionOwner: "node",
				MigrationState:  "node_owned",
				GoRoutes: []Route{{
					Transport: "http", Methods: []string{"POST"}, Path: "/v1/claude-relay-leases", Role: "explicit private Preview/canary only",
				}},
				NodeRoutes: []Route{{
					Transport: "http", Methods: []string{"*"}, Path: "/v0/webui/*", Role: "formal Node control surface",
				}},
			},
		},
	}
}
