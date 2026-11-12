package webuiproviderauthsourcesapi

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

const (
	// kindLocal 是本机来源（读宿主客户端自己写的登录态）。
	kindLocal = "local"
	// kindRemote 是远程来源（设备码 / 粘贴 token），不依赖本机客户端。
	kindRemote = "remote"

	// appCLI / appDesktop 是来源声明的客户端形态，取值与 Node 描述符的 requires.app 一致。
	appCLI     = "cli"
	appDesktop = "desktop"

	// reasonClientUnavailable 表示客户端或登录态不在这台机器上。
	reasonClientUnavailable = "client_unavailable"
	// reasonUnavailable 表示来源自身不可用（非客户端原因）。
	reasonUnavailable = "unavailable"
	// reasonClientNotInstalled 表示客户端没装但这个平台有安装方案（界面据此给安装入口）。
	reasonClientNotInstalled = "client_not_installed"
	// reasonAccountAlreadyRegistered 表示本机登录态已经在账号池里（界面不再显示导入入口）。
	reasonAccountAlreadyRegistered = "account_already_registered"

	// kiroIDETokenRelative 是 Kiro IDE 自己写的登录态文件（相对宿主 HOME）。
	kiroIDETokenRelative = ".aws/sso/cache/kiro-auth-token.json"
	// familyHostScanDescription 是 CodeBuddy 家族共用的来源说明。
	familyHostScanDescription = "扫描本机 CodeBuddy / WorkBuddy 登录态并入库（家族共享凭据同步）"
)

// probe 决定一个来源「现在能不能用」。Node 用来源自报的函数，这里用枚举，
// 让探测边界（只判存在性）在类型上就写死。
type probe int

const (
	// probeClientPresence 按 requiresApp 判客户端装没装（Node 的 host.appAvailable）。
	probeClientPresence probe = iota
	// probeHostArtifacts 判宿主凭据产物是否存在（Node 的 readHostAuthState）。
	probeHostArtifacts
	// probeKiroIDEToken 判 Kiro IDE 登录态文件是否存在。
	probeKiroIDEToken
)

// sourceDescriptor 是一个认证来源的声明。
//
// 与 Node 描述符同形：只描述「这个来源是什么」，可用性交给 probe 判定。
type sourceDescriptor struct {
	ID              string
	Kind            string
	ClientDependent bool
	RequiresApp     string
	AuthMode        string
	Handler         string
	DirectImport    bool
	Description     string
	Probe           probe
	// PluginLogin 只对插件来源为真：登录任务走插件的 /plugin-login。
	PluginLogin bool
	// Identity 是插件自报的账号指纹；内置来源恒为空（它们的指纹由宿主端口现算）。
	Identity string
	// Availability 非 nil 表示可用性由声明方自报（插件），不再走 probe 探测。
	Availability *bool
}

// declaredSources 是与 Node 描述符逐条对齐的特殊来源。
//
// 来源（Node 侧唯一事实）：
//   - lib/providers/defs/kiro.js：IDE 登录态 + 三条远程来源；
//   - lib/providers/defs/cline.js：宿主登录态扫描；
//   - lib/providers/defs/_shared/codebuddy-family.js：家族共享凭据扫描。
//
// 未列在这里的 Provider 走 hostLocalSources 的默认注入（Node 的
// withDefaultHostAuthSources），所以新增 Provider 不需要改这张表。
var declaredSources = map[string][]sourceDescriptor{
	"kiro": {
		{
			ID:              "kiro-ide-local",
			Kind:            kindLocal,
			ClientDependent: true,
			RequiresApp:     appDesktop,
			AuthMode:        string(providers.AuthModeOAuthRefreshToken),
			Probe:           probeKiroIDEToken,
			Description:     "读取本机 Kiro IDE 的登录态（~/.aws/sso/cache/kiro-auth-token.json），不需要用户手动拷文件",
		},
		{
			ID:          "kiro-device-code",
			Kind:        kindRemote,
			AuthMode:    string(providers.AuthModeOAuthDevice),
			Handler:     "device-code",
			Description: "AWS SSO OIDC 设备码授权（Builder ID / IAM Identity Center），任意设备可完成",
		},
		{
			ID:          "kiro-social-device-code",
			Kind:        kindRemote,
			AuthMode:    string(providers.AuthModeOAuthDevice),
			Handler:     "social-device-code",
			Description: "Google / GitHub 账号的设备码授权（不需要本机浏览器回调，远程可用）",
		},
		{
			ID:          "kiro-paste-token",
			Kind:        kindRemote,
			AuthMode:    string(providers.AuthModeOAuthRefreshToken),
			Handler:     "paste-token",
			Description: "粘贴 Kiro Desktop / Google / GitHub 账号的 refresh_token",
		},
	},
	"cline": {
		hostScanSource("cline", "扫描本机 cline 登录态并入库（宿主 ~/.cline 凭据同步）"),
	},
	"codebuddy":   {hostScanSource("codebuddy", familyHostScanDescription)},
	"codebuddycn": {hostScanSource("codebuddycn", familyHostScanDescription)},
	"workbuddy":   {hostScanSource("workbuddy", familyHostScanDescription)},
	"workbuddycn": {hostScanSource("workbuddycn", familyHostScanDescription)},
}

// hostScanSource 是「扫描宿主登录态并入库」这一类来源的声明。
func hostScanSource(provider, description string) sourceDescriptor {
	return sourceDescriptor{
		ID:              provider + "-host-scan",
		Kind:            kindLocal,
		ClientDependent: true,
		RequiresApp:     appCLI,
		AuthMode:        string(providers.AuthModeOAuthBrowser),
		Handler:         "host-account-scan",
		Description:     description,
	}
}

// descriptorsFor 返回某 Provider 的来源声明；没有声明时返回 nil（= supported:false）。
func descriptorsFor(provider string, definition providers.Definition) []sourceDescriptor {
	if declared, found := declaredSources[provider]; found {
		return declared
	}
	return hostLocalSources(provider, definition)
}

// hostLocalSources 复刻 Node 的默认注入：有宿主凭据产物、且声明了认证方式的 Provider，
// 自动获得一个「从本机导入」来源。描述符显式声明来源时不会走到这里。
func hostLocalSources(provider string, definition providers.Definition) []sourceDescriptor {
	policy := storagepolicy.Get(provider)
	if policy == nil || len(policy.AuthArtifacts) == 0 {
		return nil
	}
	authMode := defaultHostAuthMode(definition)
	if authMode == "" {
		return nil
	}
	return []sourceDescriptor{{
		ID:              provider + "-host-local",
		Kind:            kindLocal,
		ClientDependent: true,
		RequiresApp:     appCLI,
		AuthMode:        authMode,
		DirectImport:    true,
		Probe:           probeHostArtifacts,
		Description:     "读取本机 " + provider + " 客户端的登录态并直接入库，不需要用户手动导出",
	}}
}

// defaultHostAuthMode 与 Node 同规则：声明了 oauth-browser 就挂它（用户在那里点「从本机导入」），
// 否则挂第一个声明的认证方式。
func defaultHostAuthMode(definition providers.Definition) string {
	if len(definition.AuthOptions) == 0 {
		return ""
	}
	for _, option := range definition.AuthOptions {
		if option.Value == providers.AuthModeOAuthBrowser {
			return string(option.Value)
		}
	}
	return string(definition.AuthOptions[0].Value)
}

// describeMethods 把来源声明翻成「按认证方式分组」的视图。
//
// 排序与分组语义与 Node 一致：① 可用优先 → ② 本机来源优先 → ③ id 稳定序；
// 分组按排序后首次出现的顺序，界面据此决定先推哪个认证方式。
func (handler *Handler) describeMethods(
	ctx context.Context,
	provider string,
	definition providers.Definition,
	descriptors []sourceDescriptor,
) []methodView {
	// 已入库指纹每个请求只取一次：每个来源都单独查一遍账号池会把一次只读请求放大成 N 次。
	identities := handler.existingIdentities(ctx, provider)
	views := make([]sourceView, 0, len(descriptors))
	for _, descriptor := range descriptors {
		views = append(views, handler.describe(ctx, provider, definition, descriptor, identities))
	}
	sort.SliceStable(views, func(left, right int) bool {
		return compareSources(views[left], views[right]) < 0
	})
	methods := make([]methodView, 0, len(views))
	positions := make(map[string]int, len(views))
	for _, view := range views {
		// 没有认证方式的来源不进任何方法（与 Node 一致：界面上无处可挂）。
		if view.AuthMode == "" {
			continue
		}
		position, found := positions[view.AuthMode]
		if !found {
			position = len(methods)
			positions[view.AuthMode] = position
			methods = append(methods, methodView{AuthMode: view.AuthMode, Sources: []sourceView{}})
		}
		method := &methods[position]
		method.Sources = append(method.Sources, view)
		if method.PreferredSourceID == "" && view.Available {
			method.PreferredSourceID = view.ID
		}
		if method.InstallableSourceID == "" && view.Installable {
			method.InstallableSourceID = view.ID
		}
		if view.Kind == kindLocal && view.Available {
			method.LocalSourceAvailable = true
		}
	}
	return methods
}

// describe 判定单个来源的可用性并生成视图。
//
// 判定顺序与 Node 的 describeSource 逐条一致：
//
//	appAvailable  = 客户端登录态在不在（插件来源是插件自报）
//	installable   = 客户端不可用、且声明了客户端形态、且这个平台有安装方案
//	alreadyImported = 客户端可用、能算出指纹、且指纹已在账号池里
//	available     = appAvailable && !alreadyImported
//
// 注意 installable 用的是 appAvailable 而不是最终的 available：一个「装了就能导入」
// 的来源即使当前已被粘贴 token 兜底，也要保留安装提示（Node 的注释写明了这一点）。
func (handler *Handler) describe(
	ctx context.Context,
	provider string,
	definition providers.Definition,
	descriptor sourceDescriptor,
	identities map[string]struct{},
) sourceView {
	appAvailable := handler.available(provider, definition, descriptor)
	installable := !appAvailable && descriptor.RequiresApp != "" &&
		handler.canInstall(provider, definition, descriptor.RequiresApp)
	alreadyImported := false
	if appAvailable {
		// 指纹读不出来时不做判断（fail-open）：宁可多给一个导入入口，
		// 也不能把可用的本机登录态误标成「已入库」。
		if identity := handler.sourceIdentitySeed(ctx, provider, descriptor); identity != "" {
			_, alreadyImported = identities[identity]
		}
	}
	available := appAvailable && !alreadyImported
	reason := ""
	switch {
	case available:
	case alreadyImported:
		reason = reasonAccountAlreadyRegistered
	case installable:
		reason = reasonClientNotInstalled
	case descriptor.RequiresApp != "":
		reason = reasonClientUnavailable
	default:
		reason = reasonUnavailable
	}
	return sourceView{
		ID:              descriptor.ID,
		Kind:            descriptor.Kind,
		ClientDependent: descriptor.ClientDependent,
		RequiresApp:     descriptor.RequiresApp,
		AuthMode:        descriptor.AuthMode,
		Handler:         descriptor.Handler,
		PluginLogin:     descriptor.PluginLogin,
		DirectImport:    descriptor.DirectImport,
		Description:     descriptor.Description,
		Available:       available,
		Installable:     installable,
		AlreadyImported: alreadyImported,
		Reason:          reason,
	}
}

// existingIdentities 取该 Provider 已入库账号的指纹集合；没有端口或读失败都返回空集合，
// 调用方据此退化成「不做去重判断」——与 Node 收集指纹失败时的行为一致。
func (handler *Handler) existingIdentities(ctx context.Context, provider string) map[string]struct{} {
	if handler.identities == nil {
		return nil
	}
	identities, err := handler.identities(ctx, provider)
	if err != nil {
		return nil
	}
	return identities
}

// sourceIdentitySeed 返回来源当前登录态的身份指纹；读不出来返回空串。
func (handler *Handler) sourceIdentitySeed(ctx context.Context, provider string, descriptor sourceDescriptor) string {
	// 插件来源的指纹由插件自报，宿主不再读一遍凭据。
	if descriptor.Identity != "" {
		return strings.TrimSpace(descriptor.Identity)
	}
	if handler.sourceIdentity == nil || descriptor.Kind != kindLocal {
		return ""
	}
	identity, ok := handler.sourceIdentity(ctx, provider, descriptor.ID)
	if !ok {
		return ""
	}
	return strings.TrimSpace(identity)
}

// canInstall 回答「这个平台有没有该 Provider 这一类客户端的安装方案」。
func (handler *Handler) canInstall(provider string, definition providers.Definition, app string) bool {
	if handler.canInstallOverride != nil {
		return handler.canInstallOverride(provider, app)
	}
	return installableFromContract(definition, app)
}

// installableFromContract 是 Go 侧的安装方案**声明**判定。
//
// Node 问的是安装器注册表的 resolveInstallPlans / installCli 是否存在；Go 没有注册表，
// 只能看 Provider 合同里声明的安装落点，口径仍然保守：
//   - cli：合同声明了可分发到本机的包（Definition.CLI.Package）才算有方案——
//     没有包名的 CLI 无法通过 aih 自己的安装链路装上，直接说「可安装」会骗用户去点。
//   - desktop：合同为该平台声明了至少一个安装落点（DesktopClient.<platform>.InstallPaths）。
//   - 其它形态或平台没有声明：不可安装。
//
// 判定失败一律当作不可安装（与 Node 安装器抛错时的保守回答一致）。
func installableFromContract(definition providers.Definition, app string) bool {
	switch app {
	case appCLI:
		return definition.CLI != nil && strings.TrimSpace(definition.CLI.Package) != ""
	case appDesktop:
		return desktopInstallDeclared(definition, runtime.GOOS)
	default:
		return false
	}
}

// desktopInstallDeclared 判该平台的桌面客户端是否声明了安装落点。
func desktopInstallDeclared(definition providers.Definition, goos string) bool {
	if definition.CLI == nil || definition.CLI.DesktopClient == nil {
		return false
	}
	platform := desktopPlatform(definition.CLI.DesktopClient, goos)
	if platform == nil {
		return false
	}
	for _, path := range platform.InstallPaths {
		if strings.TrimSpace(path) != "" {
			return true
		}
	}
	return false
}

// desktopPlatform 按运行平台取桌面客户端声明。
func desktopPlatform(client *providers.DesktopClient, goos string) *providers.DesktopPlatform {
	switch goos {
	case "darwin":
		return client.MacOS
	case "windows":
		return client.Windows
	case "linux":
		return client.Linux
	default:
		return nil
	}
}

// pluginDescriptors 把外部账号插件的来源声明翻成内置来源同形的描述符。
func (handler *Handler) pluginDescriptors(ctx context.Context, provider string) []sourceDescriptor {
	if handler.pluginSources == nil {
		return nil
	}
	declared, err := handler.pluginSources(ctx, provider)
	if err != nil || len(declared) == 0 {
		return nil
	}
	descriptors := make([]sourceDescriptor, 0, len(declared))
	for _, source := range declared {
		id := strings.TrimSpace(source.ID)
		if id == "" {
			continue
		}
		// 插件没声明可用性时按 Node 的 source.available !== false 视为可用。
		available := source.Available == nil || *source.Available
		descriptors = append(descriptors, sourceDescriptor{
			ID:              id,
			Kind:            source.Kind,
			ClientDependent: source.ClientDependent,
			RequiresApp:     source.RequiresApp,
			AuthMode:        source.AuthMode,
			PluginLogin:     source.PluginLogin,
			DirectImport:    source.DirectImport,
			Description:     source.Description,
			Identity:        strings.TrimSpace(source.Identity),
			Availability:    &available,
		})
	}
	return descriptors
}

// available 只做存在性判断，不读凭据内容、不启动进程。
//
// 插件来源的可用性由插件自报（插件才知道宿主登录态与设备环境），宿主不猜。
func (handler *Handler) available(provider string, definition providers.Definition, descriptor sourceDescriptor) bool {
	if descriptor.Availability != nil {
		return *descriptor.Availability
	}
	switch descriptor.Probe {
	case probeHostArtifacts:
		return handler.hostAuthArtifactsPresent(provider)
	case probeKiroIDEToken:
		return pathExists(handler.hostPath(kiroIDETokenRelative))
	default:
		if descriptor.RequiresApp == "" {
			return true
		}
		if descriptor.RequiresApp != appCLI {
			// 桌面来源都自带探针（Kiro IDE 登录态就是如此）。没有探针时不把
			// 「客户端装没装」当成「能不能导入」，保守判不可用。
			return false
		}
		return handler.cliInstalled(provider, definition)
	}
}

// hostAuthArtifactsPresent 判定宿主登录态是否可读：只看产物文件在不在。
//
// 规则与 Node 的 readHostAuthState 一致：必选产物缺一个即不可用，可选产物缺失不影响，
// 但至少要存在一个产物——「全部可选且都没写」等于没有登录态。
func (handler *Handler) hostAuthArtifactsPresent(provider string) bool {
	if handler.hostHomeDir == "" {
		return false
	}
	policy := storagepolicy.Get(provider)
	if policy == nil || len(policy.AuthArtifacts) == 0 {
		return false
	}
	found := 0
	for _, artifact := range policy.AuthArtifacts {
		relative := hostRelativeSegments(policy.HostAuthRoot, artifact.Path)
		if len(relative) == 0 {
			continue
		}
		candidate := filepath.Join(append([]string{handler.hostHomeDir}, relative...)...)
		if pathExists(candidate) {
			found++
			continue
		}
		if !artifact.Optional {
			return false
		}
	}
	return found > 0
}

// hostRelativeSegments 把产物路径换算成相对宿主 HOME 的路径。
//
// policy 里的 artifact.path 相对 Provider 配置根，hostAuthRoot 是它与宿主 HOME 的差值；
// 已经带宿主根的 Provider（claude 的 .claude/.credentials.json）不重复拼接。
func hostRelativeSegments(hostAuthRoot, artifactPath []string) []string {
	root := trimmedSegments(hostAuthRoot)
	path := trimmedSegments(artifactPath)
	if len(root) == 0 || hasSegmentPrefix(path, root) {
		return path
	}
	return append(append([]string{}, root...), path...)
}

// cliInstalled 判 Provider 官方 CLI 是否装在这台机器上。
func (handler *Handler) cliInstalled(provider string, definition providers.Definition) bool {
	if !definition.Clients.CLI || definition.CLI == nil {
		return false
	}
	binaryName := strings.TrimSpace(definition.CLI.BinaryName)
	if binaryName == "" {
		// 与入口探测一致：没有显式 BinaryName 时按 Provider ID 找同名可执行文件。
		binaryName = definition.ID
	}
	if binaryName == "" {
		return false
	}
	return handler.findExecutable(binaryName)
}

// findExecutable 依次尝试 PATH（LookPath）与固定安装落点目录。
//
// 口径与 webuiappentriesapi 的入口探测一致：后台 Server 继承的 PATH 往往不含
// $HOME/.local/bin 与 Homebrew 前缀，只查 PATH 会把「装了但不在 PATH」说成没装。
// 两处必须同结论，否则同一个宿主上两个端点互相矛盾。
func (handler *Handler) findExecutable(name string) bool {
	if handler.lookPath != nil {
		if _, err := handler.lookPath(name); err == nil {
			return true
		}
	}
	for _, directory := range handler.searchDirs {
		for _, candidateName := range executableNameVariants(name) {
			if isExecutableFile(filepath.Join(directory, candidateName)) {
				return true
			}
		}
	}
	return false
}

// defaultSearchDirs 是 LookPath 之外的固定候选目录。
func defaultSearchDirs(hostHomeDir string) []string {
	directories := make([]string, 0, 3)
	if hostHomeDir != "" {
		directories = append(directories, filepath.Join(hostHomeDir, ".local", "bin"))
	}
	if runtime.GOOS != "windows" {
		directories = append(directories, "/usr/local/bin", "/opt/homebrew/bin")
	}
	return directories
}

// hostPath 把 HOME 相对路径展开成绝对路径；宿主 HOME 未知时返回空串。
func (handler *Handler) hostPath(relative string) string {
	if handler.hostHomeDir == "" {
		return ""
	}
	return filepath.Join(handler.hostHomeDir, filepath.FromSlash(relative))
}

// pathExists 只判存在性，不打开文件。
func pathExists(candidate string) bool {
	if candidate == "" {
		return false
	}
	_, err := os.Stat(candidate)
	return err == nil
}

// executableNameVariants 在 Windows 上补 .exe 候选；其它平台原样返回。
func executableNameVariants(name string) []string {
	if runtime.GOOS != "windows" || strings.Contains(name, ".") {
		return []string{name}
	}
	return []string{name, name + ".exe"}
}

// isExecutableFile 要求候选是文件且具备可执行位（Windows 不区分可执行位）。
func isExecutableFile(candidate string) bool {
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

// compareSources 复刻 Node 的 compareAuthSources：可用优先 → 本机来源优先 → id 稳定序。
func compareSources(left, right sourceView) int {
	if left.Available != right.Available {
		if right.Available {
			return 1
		}
		return -1
	}
	if left.ClientDependent != right.ClientDependent {
		if right.ClientDependent {
			return 1
		}
		return -1
	}
	return strings.Compare(left.ID, right.ID)
}

// trimmedSegments 去掉空白与空段，避免拼出空目录层级。
func trimmedSegments(values []string) []string {
	segments := make([]string, 0, len(values))
	for _, value := range values {
		if segment := strings.TrimSpace(value); segment != "" {
			segments = append(segments, segment)
		}
	}
	return segments
}

// hasSegmentPrefix 判断路径是否以给定段前缀开头（大小写不敏感，与 Node 一致）。
func hasSegmentPrefix(path, prefix []string) bool {
	if len(prefix) == 0 || len(path) < len(prefix) {
		return false
	}
	for index, segment := range prefix {
		if !strings.EqualFold(path[index], segment) {
			return false
		}
	}
	return true
}
