package providers

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var providerIDPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

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
	for index, definition := range manifest.Providers {
		if err := validateDefinition(definition); err != nil {
			return fmt.Errorf("provider[%d] %q 无效: %w", index, definition.ID, err)
		}
		if _, exists := seen[definition.ID]; exists {
			return fmt.Errorf("provider id 重复: %s", definition.ID)
		}
		seen[definition.ID] = struct{}{}
	}

	if _, exists := seen[manifest.Fallback.ID]; !exists {
		return fmt.Errorf("provider fallback 指向未知 id: %s", manifest.Fallback.ID)
	}
	return nil
}

// validateDefinition 校验单个 Provider 的稳定身份和声明式能力。
func validateDefinition(definition Definition) error {
	if !providerIDPattern.MatchString(definition.ID) {
		return errors.New("id 只能使用小写字母、数字和连字符")
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
	// API-only Provider 可以没有 CLI；只有声明了 CLI 才校验运行时投影字段。
	if definition.CLI != nil {
		if strings.TrimSpace(definition.CLI.GlobalDir) == "" {
			return errors.New("cli.globalDir 不能为空")
		}
		if definition.CLI.Order < 1 {
			return errors.New("cli.order 必须为正整数")
		}
	}
	return nil
}

// validateCapabilities 防止能力拼写错误变成静默的运行时缺失。
func validateCapabilities(capabilities []Capability) error {
	allowed := map[Capability]struct{}{
		CapabilityAPIKeyAccount: {},
		CapabilityModelCatalog:  {},
		CapabilityQuotaUsage:    {},
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

// validateAuthOptions 保证 Client 不会因为缺少认证选项而在添加账号时崩溃。
func validateAuthOptions(options []AuthOption) error {
	if len(options) == 0 {
		return errors.New("authOptions 不能为空")
	}
	allowed := map[AuthMode]struct{}{
		AuthModeAPIKey:       {},
		AuthModeAuthToken:    {},
		AuthModeOAuthBrowser: {},
		AuthModeOAuthDevice:  {},
		AuthModeVertexAI:     {},
	}
	seen := make(map[AuthMode]struct{}, len(options))
	for _, option := range options {
		if _, ok := allowed[option.Value]; !ok {
			return fmt.Errorf("未知 auth mode: %s", option.Value)
		}
		if _, exists := seen[option.Value]; exists {
			return fmt.Errorf("auth mode 重复: %s", option.Value)
		}
		if strings.TrimSpace(option.Label) == "" || strings.TrimSpace(option.Description) == "" {
			return fmt.Errorf("auth mode %s 缺少展示文案", option.Value)
		}
		seen[option.Value] = struct{}{}
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
	case SessionSyncPolling, SessionSyncUnavailable:
		if strings.TrimSpace(sync.Adapter) != "" || len(sync.Events) > 0 {
			return errors.New("非 hook 同步不能声明 hook adapter 或 events")
		}
	default:
		return fmt.Errorf("未知 session sync mode: %s", sync.Mode)
	}
	return nil
}
