package deletionprojection

// providerProjectionSpec 描述一个 Provider 在删除准备阶段需要的全部投影知识。
//
// 为什么必须是表驱动：每个 Provider 的凭据文件、私有目录和宿主资源落点都不同。
// 如果按 Provider 写 switch，新增一个 Provider 就要同时改投影分类、资源迁移、
// 凭据收敛三个核心文件，删除主流程会被 Provider 列表反复打开、反复改坏。
// 这里把差异收敛成数据：核心代码只按 Provider 查表，新增 Provider 只新增一条规格。
type providerProjectionSpec struct {
	// roots 按投影根类型声明私有路径和资源映射。
	roots map[projectionKind]projectionRootSpec
	// extraRoots 声明 auth-projections 之外的固定投影根（例如 Codex Desktop 的 CODEX_HOME）。
	extraRoots []projectionRootLocation
	// credential 描述删除前如何从投影回收凭据。
	credential credentialSpec
}

// projectionRootSpec 是一个投影根内部的分类规则。
type projectionRootSpec struct {
	// privateRoot 表示投影根整体都是账号私有一次状态（伪 HOME 镜像）：根下每个
	// 条目都随投影删除，不向宿主迁移任何东西。共享缓存/会话在投影里本身就是
	// 指回宿主的链接，删链接不影响宿主；未列名的 logs、traces、cli-home 之类
	// 也只属于这一份一次性投影。
	//
	// 这类 Provider 的私有资产太多且会随客户端版本增加，逐条枚举迟早漏掉一条
	// 而让删除 fail-closed；整根声明与 Node 的 rm -rf 语义一致，也不会误迁宿主。
	privateRoot bool
	// privateArtifacts 命中后不迁移，随投影根一起删除。
	privateArtifacts []privateProjectionPath
	// resourceMappings 把投影内的相对前缀映射到宿主 HOME 下的目录。
	// 为空表示该 Provider 的投影只随投影删除，不向宿主迁移任何条目。
	resourceMappings []projectionResourceMapping
}

// projectionResourceMapping 是一条「投影相对路径 -> 宿主相对路径」映射。
type projectionResourceMapping struct {
	// from 是相对投影根的路径前缀；空表示匹配所有未命中私有路径的条目。
	from []string
	// to 是相对宿主 HOME 的目标前缀。
	to []string
}

// projectionRootLocation 声明 auth-projections 之外的固定投影根。
type projectionRootLocation struct {
	kind projectionKind
	// prefix 相对 AIH 数据根，accountRef 由删除流程追加。
	prefix []string
}

// credentialMode 选择凭据收敛语义；具体实现按模式查表，不按 Provider 分支。
type credentialMode uint8

const (
	// credentialUnset 是零值：漏写 mode 的规格不能被当成「无需收敛」静默通过。
	credentialUnset credentialMode = iota
	// credentialNone 显式声明「删除投影时不采纳凭据」。用于凭据格式在 Go 侧
	// 无法比较代际、或 Node 现状本来就不采纳的 Provider。
	credentialNone
	credentialCodexOAuth
	credentialClaudeOAuth
	credentialNativeGeneration
	// credentialKiroSQLite 从账号投影里的 data.sqlite3 读取 kiro CLI 的
	// auth_kv，再按 nativeaccount 的 kiro 形状重建凭据。
	credentialKiroSQLite
)

// credentialSpec 声明一个 Provider 的凭据投影文件与收敛语义。
type credentialSpec struct {
	mode      credentialMode
	artifacts []credentialArtifact
}

// credentialArtifactFormat 决定投影文件如何嵌入 native_auth_json。
//
// json 直接作为 JSON 值；text 作为 JSON 字符串（qoder 的 .auth/user、
// machine_id 是纯文本/opaque blob，不是 JSON 文档）。
type credentialArtifactFormat uint8

const (
	credentialArtifactJSON credentialArtifactFormat = iota
	credentialArtifactText
)

// credentialArtifactNormalizer 声明投影文档入库前必须做的收窄。
//
// 表驱动：核心代码只按枚举查实现，不按 Provider 名分支。cline 的
// providers.json 是跨 Provider 的整库，直接入库会把别人的明文密钥抄进本账号。
type credentialArtifactNormalizer uint8

const (
	normalizeNone credentialArtifactNormalizer = iota
	normalizeClineProviders
)

// credentialArtifact 是投影根内的一个凭据文件。
type credentialArtifact struct {
	rootKind projectionKind
	// field 是重建 native_auth_json 时的顶层字段；codex/claude 的 typed 模式忽略它。
	field    string
	segments []string
	optional bool
	format   credentialArtifactFormat
	// normalize 在嵌入 envelope 前收窄整库文档（cline 的 providers.json）。
	normalize credentialArtifactNormalizer
}

// projectionSpecs 是 Provider 删除投影的唯一注册点。
var projectionSpecs = map[string]providerProjectionSpec{
	providerCodex: {
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				privateArtifacts: codexAccountPrivatePaths(),
				resourceMappings: []projectionResourceMapping{
					{from: []string{".codex"}, to: []string{".codex"}},
				},
			},
			projectionKindCodexDesktop: {
				privateArtifacts: codexDesktopPrivatePaths(),
				resourceMappings: []projectionResourceMapping{
					// Desktop 投影根本身就是 CODEX_HOME；未命中私有路径的条目都回到宿主 .codex。
					{to: []string{".codex"}},
				},
			},
		},
		extraRoots: []projectionRootLocation{
			{kind: projectionKindCodexDesktop, prefix: []string{"run", "codex-desktop"}},
		},
		credential: credentialSpec{
			mode: credentialCodexOAuth,
			artifacts: []credentialArtifact{
				{rootKind: projectionKindAccount, segments: []string{".codex", "auth.json"}},
				{rootKind: projectionKindCodexDesktop, segments: []string{"auth.json"}},
			},
		},
	},
	providerClaude: {
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				privateArtifacts: claudeAccountPrivatePaths(),
				resourceMappings: []projectionResourceMapping{
					{from: []string{".claude"}, to: []string{".claude"}},
				},
			},
		},
		credential: credentialSpec{
			mode: credentialClaudeOAuth,
			artifacts: []credentialArtifact{
				{rootKind: projectionKindAccount, segments: []string{".claude", ".credentials.json"}},
			},
		},
	},
	providerGemini: {
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				// gemini 与 agy 共用宿主 ~/.gemini：投影里的共享条目都是指回宿主的
				// 链接，其余条目属于这份一次性投影。删除时只能整体随投影丢弃，
				// 绝不能迁回宿主，否则会改到 agy 也在读写的文件。
				privateArtifacts: []privateProjectionPath{
					{segments: []string{".gemini"}, subtree: true},
					{segments: []string{"Library", "Keychains"}, subtree: true},
				},
				// 无 resourceMappings：gemini 的投影只删不迁。
			},
		},
		credential: credentialSpec{
			mode: credentialNativeGeneration,
			artifacts: []credentialArtifact{
				{rootKind: projectionKindAccount, field: "oauthCreds", segments: []string{".gemini", "oauth_creds.json"}},
				{rootKind: projectionKindAccount, field: "googleAccounts", segments: []string{".gemini", "google_accounts.json"}, optional: true},
			},
		},
	},
	providerGrok: {
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				// grok 的投影同样只删不迁：宿主 ~/.grok 是官方 CLI 的原生库，
				// 删除账号投影不应改写其中任何文件。
				privateArtifacts: []privateProjectionPath{
					{segments: []string{".grok"}, subtree: true},
					{segments: []string{"Library", "Keychains"}, subtree: true},
				},
			},
		},
		credential: credentialSpec{
			mode: credentialNativeGeneration,
			artifacts: []credentialArtifact{
				{rootKind: projectionKindAccount, field: "auth", segments: []string{".grok", "auth.json"}},
			},
		},
	},
	providerCline: {
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				// cline 的 CLINE_DIR / CLINE_DATA_DIR 都钉在投影根里：settings/providers.json、
				// secrets.json、日志、缓存和会话软链全在 .cline 树下。它们都是这份一次性投影的
				// 私有状态；会话软链随投影删除只会摘掉链接，不会动宿主那批会话文件。
				//
				// 多落点必须显式列出：providers.json 是跨 Provider 的整库，secrets.json 又是
				// CLI 自己的 API Key 仓，漏掉任何一个都会在投影里留下残留凭据。
				privateArtifacts: []privateProjectionPath{
					{segments: []string{".cline"}, subtree: true},
					{segments: []string{"Library", "Keychains"}, subtree: true},
					{segments: []string{"electron-user-data"}, subtree: true},
				},
				// 无 resourceMappings：只删账号投影，宿主 ~/.cline 不改。
			},
		},
		credential: credentialSpec{
			mode: credentialNativeGeneration,
			artifacts: []credentialArtifact{
				{
					rootKind:  projectionKindAccount,
					field:     "auth",
					segments:  []string{".cline", "data", "settings", "providers.json"},
					normalize: normalizeClineProviders,
				},
			},
		},
	},
	providerOpencode: {
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				// opencode 的认证有三个落点：XDG 数据根的 canonical auth.json、
				// XDG 桥接目录里指向它的软链，以及旧布局留在配置根的 auth.json 备份。
				// 三个都必须按私有路径处理：漏掉 canonical 或备份会把凭据当资源迁回宿主，
				// 漏掉桥接软链会在投影里留下指向已删文件的悬空链接。
				//
				// .local / .config 下的其余条目都是共享数据的软链或本账号一次性缓存，
				// 整棵随投影删除即可，宿主目录不会变化。
				privateArtifacts: []privateProjectionPath{
					{segments: []string{".local"}, subtree: true},
					{segments: []string{".config"}, subtree: true},
					{segments: []string{"Library", "Keychains"}, subtree: true},
					{segments: []string{"electron-user-data"}, subtree: true},
				},
				// 无 resourceMappings：只删账号投影，宿主共享数据不改。
			},
		},
		credential: credentialSpec{
			mode: credentialNativeGeneration,
			artifacts: []credentialArtifact{
				// 备份先声明、canonical 后声明：两份同时存在时 canonical 覆盖备份，
				// 不能反过来用旧备份顶掉当前登录态。
				{
					rootKind: projectionKindAccount,
					field:    "auth",
					segments: []string{".config", "opencode", "auth.json"},
					optional: true,
				},
				{
					rootKind: projectionKindAccount,
					field:    "auth",
					segments: []string{".local", "share", "opencode", "auth.json"},
				},
			},
		},
	},
	providerQoder:   qoderProjectionSpec(),
	providerQoderCN: qoderProjectionSpec(),

	providerCodebuddy:   codebuddyFamilyProjectionSpec(),
	providerCodebuddyCN: codebuddyFamilyProjectionSpec(),
	providerWorkbuddy:   codebuddyFamilyProjectionSpec(),
	providerWorkbuddyCN: codebuddyFamilyProjectionSpec(),
	providerKimi:        kimiProjectionSpec(),
	providerKiro:        kiroProjectionSpec(),
}

// qoderProjectionSpec 返回 Qoder 两个区域共用的投影规格。
//
// 两家的 --config-dir 布局完全相同（只有可执行文件与宿主根 .qoder/.qoder-cn 不同，
// 宿主根不参与删除投影），所以规格只保持一份，避免双区漂移。
func qoderProjectionSpec() providerProjectionSpec {
	return providerProjectionSpec{
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				// Qoder 把登录态拆在多个落点：.auth/user（encrypted 或 opaque）、
				// .auth/machine_id（WASM 解密密钥）和 .cache/dns-cache.json（账号面缓存）。
				// 多落点必须显式列出：只列 .auth 会漏掉 dns-cache，只列 user 会把
				// machine_id 当资源迁回宿主，二者都会留下或带走账号凭据。
				privateArtifacts: []privateProjectionPath{
					{segments: []string{".auth"}, subtree: true},
					{segments: []string{".cache"}, subtree: true},
					{segments: []string{"logs"}, subtree: true},
					{segments: []string{"Library", "Keychains"}, subtree: true},
					{segments: []string{"electron-user-data"}, subtree: true},
				},
				// 无 resourceMappings：只删账号投影，宿主 ~/.qoder(-cn) 不改。
			},
		},
		credential: credentialSpec{
			mode: credentialNativeGeneration,
			artifacts: []credentialArtifact{
				{
					rootKind: projectionKindAccount,
					field:    "credentials",
					segments: []string{".auth", "user"},
					format:   credentialArtifactText,
				},
				{
					rootKind: projectionKindAccount,
					field:    "machineId",
					segments: []string{".auth", "machine_id"},
					optional: true,
					format:   credentialArtifactText,
				},
				{
					rootKind: projectionKindAccount,
					field:    "dnsCache",
					segments: []string{".cache", "dns-cache.json"},
					optional: true,
				},
			},
		},
	}
}

// codebuddyFamilyProjectionSpec 是 CodeBuddy 家族四支（codebuddy / codebuddycn /
// workbuddy / workbuddycn）共用的删除规格。
//
// 四支客户端的投影布局同构（见 lib/runtime/codebuddy-family-layouts.js）：启动时
// 把宿主 HOME 里与账号无关的缓存、CLI 根做成指回宿主的链接，账号态则写成真实
// 文件。因此整个投影根就是一份一次性伪 HOME，删除时整棵丢弃即可，宿主
// ~/.codebuddy*、~/Library/Application Support/CodeBuddy* 逐字节不变。
//
// 账号私有落点（调研结论，全部随投影删除，绝不迁回宿主）：
//   - Library/Application Support/CodeBuddyExtension/Data/Public/auth/
//     {Tencent-Cloud.coding-copilot.info, workbuddy-desktop.info, workbuddy-desktop-ai.info}
//   - electron-user-data/**（桌面端 Chromium profile 与加密副本）
//   - .workbuddy-key-fallback/**
//   - .codebuddy*/sessions/**、.codebuddy*/.mcp.json、.codebuddy*/diagnostics/**
//   - Library/Keychains/**
//   - Library/Application Support/CodeBuddyExtension/{Cache,Logs}/**
//
// 不做凭据 adopt：与 Node 现状一致（Node 删除时同样不采纳投影里的 .info），
// 且家族 .info 是加密格式，Go 侧没有可比较的代际证据，无法判断该不该覆盖
// 数据库里的登录态；直接随投影删除是唯一安全语义。
func codebuddyFamilyProjectionSpec() providerProjectionSpec {
	return providerProjectionSpec{
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {privateRoot: true},
		},
		credential: credentialSpec{mode: credentialNone},
	}
}

// kimiProjectionSpec 是 kimi 的删除规格。
//
// KIMI_CODE_HOME 钉在投影根的 .kimi-code 下，桌面端另有 electron-user-data。
// 账号私有落点（全部随投影删除）：
//   - .kimi-code/credentials/kimi-code.json（native 凭据）
//   - .kimi-code/device_id
//   - .kimi-code/config.toml
//   - .kimi-code/session_index.jsonl（按账号重写的投影视图；迁回会盖掉宿主 canonical 索引）
//   - electron-user-data/**
//
// .kimi-code/sessions 等共享目录在投影里是指回宿主的链接，删链接不会动宿主。
//
// 不做凭据 adopt：kimi 的 credentials 虽然是 native 格式，但 Node 删除时同样
// 不采纳；Go 侧也没有「删除时用投影覆盖数据库」的既有语义，强行采纳会把
// 一次删号变成一次隐式换号。
func kimiProjectionSpec() providerProjectionSpec {
	return providerProjectionSpec{
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {privateRoot: true},
		},
		credential: credentialSpec{mode: credentialNone},
	}
}

// kiroProjectionSpec 是 kiro 的删除规格。
//
// kiro 的账号目录是一份一次性私有运行目录，Node 删除时直接 rm -rf 整根；
// Go 侧整根声明为 privateRoot。调研到的私有落点如下（全部随根删除）：
//   - data.sqlite3 及 -wal/-shm/-journal（CLI 的 auth_kv 与本地会话）；
//   - .aih-kiro-auth-binding（上一次投影的 grant 指纹）；
//   - electron-user-data/**（桌面 Chromium profile）；
//   - tmp/**、.config/**、.local/**（KIRO_HOME 指向宿主 ~/.kiro，这些只是
//     运行期私有目录）；
//   - Library/Application Support/kiro-cli/**（内含指向 data.sqlite3 的 file
//     symlink）与 Library/Keychains/**。
//
// 宿主 ~/.kiro、~/Library/Application Support/kiro-cli 是原生 CLI 自己的数据，
// 不经账号投影共享；整根删除只会移除账号副本或指回宿主的链接。
//
// 凭据：data.sqlite3 是二进制 SQLite，不能走 JSON artifact 路径。删除前由
// reconcileKiroCredential 只读解析 auth_kv，按 Node 的 tokenBinding 判断是否同代，
// 再用 credential-origin 的 expires_at/iat 做代际排序；不可比较时 fail-closed。
func kiroProjectionSpec() providerProjectionSpec {
	return providerProjectionSpec{
		roots: map[projectionKind]projectionRootSpec{
			projectionKindAccount: {
				// 整根都是一次性私有运行目录：Node 删除时就是 rm -rf 整个账号目录，
				// 且 kiro 的 projectionRoots 为空（没有任何条目要迁回宿主）。
				// 未列名的新客户端文件也只属于这份投影，不能因此拒绝删除。
				privateRoot: true,
			},
		},
		credential: credentialSpec{
			mode: credentialKiroSQLite,
			artifacts: []credentialArtifact{
				{rootKind: projectionKindAccount, field: "auth", segments: []string{"data.sqlite3"}},
			},
		},
	}
}

// nodeOnlyDeletionReasons 记录尚未注册投影规格的 Provider 为什么仍留在 Node。
//
// 守卫测试会遍历 Provider 目录：既没有规格、也不在这张表里，或原因为空，
// 测试都会失败。新增 Provider 时必须二选一，不能让删除流程沉默地拒绝它。
var nodeOnlyDeletionReasons = map[string]string{
	"agy":   "伪 HOME 投影与 gemini 共用 ~/.gemini，且删除前必须停掉常驻的暖机 language server 池，只有 Node 能做进程级停机",
	"zcode": "凭据是 enc:v1 加密的多文件库，且桌面数据根由桥/影子 App 共享，Go 侧既无法比较代际也无法安全迁移",
}

// projectionSpecFor 是删除流程查询 Provider 规格的唯一入口。
func projectionSpecFor(providerID string) (providerProjectionSpec, bool) {
	spec, found := projectionSpecs[providerID]
	return spec, found
}

// credentialArtifactPath 返回 typed 凭据策略使用的投影文件路径。
// native 策略会自行遍历全部 artifact，不使用这里的「首条」语义。
func credentialArtifactPath(spec credentialSpec, kind projectionKind) []string {
	for _, artifact := range spec.artifacts {
		if artifact.rootKind == kind {
			return artifact.segments
		}
	}
	return nil
}
