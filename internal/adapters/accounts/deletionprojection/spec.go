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
	credentialNone credentialMode = iota
	credentialCodexOAuth
	credentialClaudeOAuth
	credentialNativeGeneration
)

// credentialSpec 声明一个 Provider 的凭据投影文件与收敛语义。
type credentialSpec struct {
	mode      credentialMode
	artifacts []credentialArtifact
}

// credentialArtifact 是投影根内的一个凭据文件。
type credentialArtifact struct {
	rootKind projectionKind
	// field 是重建 native_auth_json 时的顶层字段；codex/claude 的 typed 模式忽略它。
	field    string
	segments []string
	optional bool
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
}

// nodeOnlyDeletionReasons 记录尚未注册投影规格的 Provider 为什么仍留在 Node。
//
// 守卫测试会遍历 Provider 目录：既没有规格、也不在这张表里，或原因为空，
// 测试都会失败。新增 Provider 时必须二选一，不能让删除流程沉默地拒绝它。
var nodeOnlyDeletionReasons = map[string]string{
	"agy":         "伪 HOME 投影与 gemini 共用 ~/.gemini，且有常驻 language server，删除仍由 Node 处理",
	"opencode":    "认证分布在 XDG 桥接目录和 provider shared store，只删投影的边界尚未验证",
	"kimi":        "KIMI_CODE_HOME 投影包含账号视图的 session_index.jsonl，删除仍由 Node 处理",
	"kiro":        "凭据投影包含 IDE SQLite 数据库，删除仍由 Node 处理",
	"zcode":       "凭据是加密多文件且桌面数据根共享，删除仍由 Node 处理",
	"cline":       "providers.json 是跨 Provider 的整库文件，删除仍由 Node 处理",
	"qoder":       "认证 artifact 与 native root 分离，删除仍由 Node 处理",
	"qodercn":     "认证 artifact 与 native root 分离，删除仍由 Node 处理",
	"codebuddy":   "登录态是宿主共享的加密文件，删除仍由 Node 处理",
	"codebuddycn": "登录态是宿主共享的加密文件，删除仍由 Node 处理",
	"workbuddy":   "登录态是宿主共享的加密文件，删除仍由 Node 处理",
	"workbuddycn": "登录态是宿主共享的加密文件，删除仍由 Node 处理",
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
