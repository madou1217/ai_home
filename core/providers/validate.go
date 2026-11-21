package providers

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var providerIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// envKeyPattern 约束凭据环境变量名为常规的大写形式。
var envKeyPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// ValidateManifest 校验 Provider 合同是否可以安全生成给其他语言使用。
func ValidateManifest(manifest Manifest) error {
	if manifest.SchemaVersion != SchemaVersion {
		return fmt.Errorf("provider schema version 不匹配: got=%d want=%d", manifest.SchemaVersion, SchemaVersion)
	}
	if len(manifest.Providers) == 0 {
		return errors.New("provider 定义不能为空")
	}
	if strings.TrimSpace(manifest.Fallback.ID) == "" || strings.TrimSpace(manifest.Fallback.Label) == "" {
		return errors.New("provider fallback 必须包含 id 和 label")
	}

	seen := make(map[string]struct{}, len(manifest.Providers))
	// 产品族 + 站点唯一：同一个产品在同一个站点上只能有一个 Provider，
	// 否则 Client 的"按族聚合"会折叠出重复入口，账号归属也变得不可判定。
	seenSite := make(map[string]string, len(manifest.Providers))
	for index, definition := range manifest.Providers {
		if err := validateDefinition(definition); err != nil {
			return fmt.Errorf("provider[%d] %q 无效: %w", index, definition.ID, err)
		}
		if _, exists := seen[definition.ID]; exists {
			return fmt.Errorf("provider id 重复: %s", definition.ID)
		}
		seen[definition.ID] = struct{}{}

		key := definition.Family + "/" + string(definition.Site)
		if owner, exists := seenSite[key]; exists {
			return fmt.Errorf(
				"产品族 %s 的站点 %s 已被 %s 占用，不能重复声明为 %s",
				definition.Family, definition.Site, owner, definition.ID)
		}
		seenSite[key] = definition.ID
	}

	if _, exists := seen[manifest.Fallback.ID]; !exists {
		return fmt.Errorf("provider fallback 指向未知 id: %s", manifest.Fallback.ID)
	}
	if err := validateCodeBuddyFamilyStorage(manifest); err != nil {
		return err
	}
	return nil
}

// validateCodeBuddyFamilyStorage 校验家族配置目录唯一，且会话根指向已知成员目录。
func validateCodeBuddyFamilyStorage(manifest Manifest) error {
	familyDirs := map[string]string{}
	family := make([]Definition, 0, 4)
	for _, definition := range manifest.Providers {
		if definition.Family != "codebuddy" && definition.Family != "workbuddy" {
			continue
		}
		family = append(family, definition)
		if definition.CLI == nil || definition.Storage == nil {
			continue
		}
		dirName := strings.TrimSpace(definition.CLI.GlobalDir)
		if owner, exists := familyDirs[dirName]; exists {
			return fmt.Errorf("CodeBuddy 家族配置目录 %q 同时属于 %s 与 %s", dirName, owner, definition.ID)
		}
		familyDirs[dirName] = definition.ID
	}
	for _, definition := range family {
		if definition.Storage == nil {
			continue
		}
		for _, root := range definition.Storage.SessionRoots {
			normalized := strings.TrimSpace(root)
			if _, exists := familyDirs[normalized]; !exists {
				return fmt.Errorf("Provider %s 的 storage.sessionRoots 包含未知配置目录 %q", definition.ID, normalized)
			}
		}
	}
	return nil
}

// validateDefinition 校验单个 Provider 的稳定身份和声明式能力。
func validateDefinition(definition Definition) error {
	if !providerIDPattern.MatchString(definition.ID) {
		return errors.New("id 只能使用小写字母、数字和连字符")
	}
	if !providerIDPattern.MatchString(definition.Family) {
		return errors.New("family 只能使用小写字母、数字和连字符")
	}
	if definition.Site != SiteGlobal && definition.Site != SiteCN {
		return fmt.Errorf("未知站点: %s", definition.Site)
	}
	if definition.Presentation.ID != definition.ID {
		return errors.New("presentation.id 必须与 provider id 一致")
	}
	if strings.TrimSpace(definition.Presentation.Label) == "" {
		return errors.New("展示名称不能为空")
	}
	if definition.Gateway != GatewayActive && definition.Gateway != GatewayDeprecated {
		return fmt.Errorf("未知 gateway 状态: %s", definition.Gateway)
	}
	if definition.NativeBoundary != nil {
		if err := validateSessionCommands(definition.NativeBoundary.Sessions); err != nil {
			return err
		}
	}
	if err := validateCapabilities(definition.Capabilities); err != nil {
		return err
	}
	if err := validateAuthOptions(definition.AuthOptions); err != nil {
		return err
	}
	if err := validateSessionSync(definition.SessionSync); err != nil {
		return err
	}
	if definition.Clients.CLI && definition.CLI == nil {
		return errors.New("clients.cli=true 必须声明 cli 配置")
	}
	if definition.Clients.Desktop && (definition.CLI == nil || definition.CLI.DesktopClient == nil) {
		return errors.New("clients.desktop=true 必须声明 desktopClient 配置")
	}
	if err := validateCredentialFacts(definition.Credentials); err != nil {
		return err
	}
	if err := validateRelayHosts(definition.RelayHosts); err != nil {
		return err
	}
	// API-only Provider 可以没有 CLI；只有声明了 CLI 才校验运行时投影字段。
	if definition.CLI != nil {
		if strings.TrimSpace(definition.CLI.GlobalDir) == "" {
			return errors.New("cli.globalDir 不能为空")
		}
		if definition.CLI.Order < 1 {
			return errors.New("cli.order 必须为正整数")
		}
		if definition.CLI.InstallRoot != nil {
			for _, segment := range *definition.CLI.InstallRoot {
				if !isSafeRelativeSegment(segment) {
					return fmt.Errorf("cli.installRoot 必须是安全的 HOME 相对段: %q", segment)
				}
			}
		}
	}
	if err := validateStorageFacts(definition); err != nil {
		return err
	}
	return nil
}

// validateStorageFacts 校验 Provider 自己声明的本地存储布局事实。
//
// CodeBuddy 家族（Family=codebuddy/workbuddy）必须完整声明：配置根来自
// cli.globalDir，其余事实来自 storage。新 Provider 加入家族时如果漏声明，
// 合同校验直接失败，不会在运行时静默退化成「没有存储策略」。
func validateStorageFacts(definition Definition) error {
	facts := definition.Storage
	isFamily := definition.Family == "codebuddy" || definition.Family == "workbuddy"
	if isFamily && facts == nil {
		return errors.New("CodeBuddy 家族 Provider 必须声明 storage 布局事实")
	}
	if facts != nil {
		if facts.NativeRoot != nil {
			for _, segment := range *facts.NativeRoot {
				if !isSafeRelativeSegment(segment) {
					return fmt.Errorf("storage.nativeRoot 必须是安全的 HOME 相对段: %q", segment)
				}
			}
		}
		if facts.DefaultAuthFile != "" && !isSafeRelativeSegment(facts.DefaultAuthFile) {
			return fmt.Errorf("storage.defaultAuthFile 必须是单段文件名: %q", facts.DefaultAuthFile)
		}
		if facts.IDEDataName != "" && !isSafeRelativeSegment(facts.IDEDataName) {
			return fmt.Errorf("storage.ideDataName 必须是单段目录名: %q", facts.IDEDataName)
		}
		for _, segment := range facts.AttachmentSubdir {
			if !isSafeRelativeSegment(segment) {
				return fmt.Errorf("storage.attachmentSubdir 必须是安全目录段: %q", segment)
			}
		}
		for _, root := range facts.SessionRoots {
			if !isSafeRelativeSegment(root) {
				return fmt.Errorf("storage.sessionRoots 必须是单段 HOME 相对目录: %q", root)
			}
		}
		if facts.HostAuthRoot != nil {
			for _, segment := range *facts.HostAuthRoot {
				if !isSafeRelativeSegment(segment) {
					return fmt.Errorf("storage.hostAuthRoot 必须是安全的 HOME 相对段: %q", segment)
				}
			}
		}
		authFields := map[string]struct{}{}
		for _, artifact := range facts.AuthArtifacts {
			field := strings.TrimSpace(artifact.Field)
			if field == "" {
				return errors.New("storage.authArtifacts.field 不能为空")
			}
			if _, duplicated := authFields[field]; duplicated {
				return fmt.Errorf("storage.authArtifacts.field 重复: %q", field)
			}
			authFields[field] = struct{}{}
			switch artifact.Base {
			case "", ArtifactBaseHome, ArtifactBaseNative, ArtifactBaseConfig, ArtifactBaseHostAuth:
			default:
				return fmt.Errorf("storage.authArtifacts.base 取值无效: %q", artifact.Base)
			}
			if !isSafeRelativePath(artifact.Path) {
				return fmt.Errorf("storage.authArtifacts.path 必须是安全的相对路径: %q", artifact.Path)
			}
		}
		privatePaths := map[string]struct{}{}
		for _, artifact := range facts.PrivateArtifacts {
			switch artifact.Base {
			case "", ArtifactBaseHome, ArtifactBaseNative, ArtifactBaseConfig, ArtifactBaseHostAuth:
			default:
				return fmt.Errorf("storage.privateArtifacts.base 取值无效: %q", artifact.Base)
			}
			if !isSafeRelativePath(artifact.Path) {
				return fmt.Errorf("storage.privateArtifacts.path 必须是安全的相对路径: %q", artifact.Path)
			}
			if _, duplicated := privatePaths[artifact.Path]; duplicated {
				return fmt.Errorf("storage.privateArtifacts.path 重复: %q", artifact.Path)
			}
			privatePaths[artifact.Path] = struct{}{}
		}
		for _, location := range facts.ConfigDenyPaths {
			if !isSafeRelativePath(location.Path) {
				return fmt.Errorf("storage.configDenyPaths 必须是安全的 HOME 相对路径: %q", location.Path)
			}
		}
	}
	for _, segment := range definition.EffectiveNativeRoot() {
		if !isSafeRelativeSegment(segment) {
			return fmt.Errorf("生效的 nativeRoot 必须是安全的 HOME 相对段: %q", segment)
		}
	}
	if !isFamily {
		return nil
	}
	if definition.CLI == nil || strings.TrimSpace(definition.CLI.GlobalDir) == "" {
		return errors.New("CodeBuddy 家族 Provider 必须声明 cli.globalDir")
	}
	if strings.TrimSpace(facts.DefaultAuthFile) == "" {
		return errors.New("CodeBuddy 家族 Provider 必须声明 storage.defaultAuthFile")
	}
	if strings.TrimSpace(facts.IDEDataName) == "" {
		return errors.New("CodeBuddy 家族 Provider 必须声明 storage.ideDataName")
	}
	if len(facts.SessionRoots) == 0 {
		return errors.New("CodeBuddy 家族 Provider 必须声明 storage.sessionRoots")
	}
	if strings.TrimSpace(facts.SessionRoots[0]) != strings.TrimSpace(definition.CLI.GlobalDir) {
		return fmt.Errorf("storage.sessionRoots 首项必须等于 cli.globalDir（%s）", definition.CLI.GlobalDir)
	}
	return nil
}

func isSafeRelativeSegment(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || trimmed == "." || trimmed == ".." {
		return false
	}
	return !strings.ContainsAny(trimmed, "/\\\\")
}

// isSafeRelativePath 校验斜杠分隔的 HOME 相对路径：每段都必须是安全单段，
// 且不接受绝对路径、空段与反斜杠。
func isSafeRelativePath(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || strings.HasPrefix(trimmed, "/") || strings.Contains(trimmed, "\\") {
		return false
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if !isSafeRelativeSegment(segment) {
			return false
		}
	}
	return true
}

// validateCredentialFacts 校验凭据事实：厂商标识小写，环境变量名合法且同一列表内不重复。
func validateCredentialFacts(facts *CredentialFacts) error {
	if facts == nil {
		return nil
	}
	if facts.VendorID != "" && !providerIDPattern.MatchString(facts.VendorID) {
		return errors.New("credentials.vendorId 只能使用小写字母、数字和连字符")
	}
	for name, keys := range map[string][]string{
		"apiKeyEnv":    facts.APIKeyEnv,
		"authTokenEnv": facts.AuthTokenEnv,
		"baseUrlEnv":   facts.BaseURLEnv,
	} {
		seen := map[string]bool{}
		for _, key := range keys {
			if !envKeyPattern.MatchString(key) {
				return fmt.Errorf("credentials.%s 环境变量名不合法: %s", name, key)
			}
			if seen[key] {
				return fmt.Errorf("credentials.%s 重复: %s", name, key)
			}
			seen[key] = true
		}
	}
	return nil
}

// validateCapabilities 防止能力拼写错误变成静默的运行时缺失。
func validateCapabilities(capabilities []Capability) error {
	allowed := map[Capability]struct{}{
		CapabilityAPIKeyAccount:       {},
		CapabilityModelCatalog:        {},
		CapabilityQuotaUsage:          {},
		CapabilitySessionRuntime:      {},
		CapabilityGatewayProfile:      {},
		CapabilitySessionHistory:      {},
		CapabilityAccountSessionStore: {},
		CapabilityUsageScan:           {},
		CapabilityACPSession:          {},
	}
	seen := make(map[Capability]struct{}, len(capabilities))
	for _, capability := range capabilities {
		if _, ok := allowed[capability]; !ok {
			return fmt.Errorf("未知 capability: %s", capability)
		}
		if _, exists := seen[capability]; exists {
			return fmt.Errorf("capability 重复: %s", capability)
		}
		seen[capability] = struct{}{}
	}
	return nil
}

// validateRelayHosts 校验「各宿主能否服务该 Provider 推理」的声明。
//
// 不变量（对应 docs/plans/2026-10-17-inference-capability-registry.md §3.4）：
//   - 宿主名只能是 node / go —— 拼错会让声明静默失效，等于回到了「没声明」；
//   - supported=false 时 reason 必填 —— 禁止沉默缺失。cline 此前不在任何名单里、
//     没人知道为什么，正是这条要消灭的形态；
//   - supported=true 时 channel 必填且取值合法 —— 「能服务」必须说清用哪条通道，
//     否则转发判定无从决定请求该怎么走；
//   - entries 只在 channel=relay 时有意义（canonical 覆盖全部推理入口）。
func validateRelayHosts(hosts map[string]RelayHost) error {
	if len(hosts) == 0 {
		return nil
	}
	for host, capability := range hosts {
		if host != RelayHostNode && host != RelayHostGo {
			return fmt.Errorf("relayHosts 含未知宿主: %s", host)
		}
		if !capability.Supported {
			if strings.TrimSpace(capability.Reason) == "" {
				return fmt.Errorf("relayHosts.%s 声明不支持时必须写明 reason", host)
			}
			if capability.Channel != "" || len(capability.Entries) > 0 {
				return fmt.Errorf("relayHosts.%s 声明不支持时不能声明 channel 或 entries", host)
			}
			continue
		}
		if capability.Channel != RelayChannelCanonical && capability.Channel != RelayChannelRelay {
			return fmt.Errorf("relayHosts.%s 的 channel 非法: %q", host, capability.Channel)
		}
		if capability.Channel == RelayChannelCanonical && len(capability.Entries) > 0 {
			return fmt.Errorf("relayHosts.%s 使用 canonical 通道时不应限定 entries（该通道覆盖全部推理入口）", host)
		}
		if capability.Reason != "" {
			return fmt.Errorf("relayHosts.%s 声明支持时不应写 reason", host)
		}
	}
	return nil
}

// validateAuthOptions 保证 Client 不会因为缺少认证选项而在添加账号时崩溃。
func validateAuthOptions(options []AuthOption) error {
	if len(options) == 0 {
		return errors.New("authOptions 不能为空")
	}
	allowed := map[AuthMode]struct{}{
		AuthModeAPIKey:            {},
		AuthModeAuthToken:         {},
		AuthModeOAuthBrowser:      {},
		AuthModeOAuthDevice:       {},
		AuthModeOAuthRefreshToken: {},
		AuthModeVertexAI:          {},
	}
	seen := make(map[string]struct{}, len(options))
	for _, option := range options {
		if _, ok := allowed[option.Value]; !ok {
			return fmt.Errorf("未知 auth mode: %s", option.Value)
		}
		strategy := strings.TrimSpace(option.Strategy)
		key := string(option.Value) + "\x00" + strategy
		if _, exists := seen[key]; exists {
			return fmt.Errorf("auth mode/strategy 重复: %s/%s", option.Value, strategy)
		}
		if strings.TrimSpace(option.Label) == "" || strings.TrimSpace(option.Description) == "" {
			return fmt.Errorf("auth mode %s 缺少展示文案", option.Value)
		}
		seen[key] = struct{}{}
	}
	return nil
}

// validateSessionSync 保证声明的同步模式和实现选择不会互相矛盾。
func validateSessionSync(sync SessionSync) error {
	switch sync.Mode {
	case SessionSyncHook:
		if strings.TrimSpace(sync.Adapter) == "" {
			return errors.New("hook 同步必须声明 adapter")
		}
		if sync.Hook != nil {
			if err := validateHookFormat(*sync.Hook, sync.Events); err != nil {
				return fmt.Errorf("hook 格式无效: %w", err)
			}
		}
	case SessionSyncPolling, SessionSyncUnavailable:
		if strings.TrimSpace(sync.Adapter) != "" || len(sync.Events) > 0 {
			return errors.New("非 hook 同步不能声明 hook adapter 或 events")
		}
		if sync.Hook != nil {
			return errors.New("非 hook 同步不能声明 hook 格式")
		}
	default:
		return fmt.Errorf("未知 session sync mode: %s", sync.Mode)
	}
	return nil
}
