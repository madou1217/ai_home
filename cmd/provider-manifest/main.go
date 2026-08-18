// Command provider-manifest 生成 Node 和 TypeScript 共用的 Provider 合同投影。
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// outputFile 描述一个需要生成或校验的目标文件。
type outputFile struct {
	RelativePath string
	Content      []byte
}

// clientSupport 描述 Provider 支持的用户客户端形态（CLI / Desktop）。
type clientSupport struct {
	CLI     bool `json:"cli"`
	Desktop bool `json:"desktop"`
}

// clientDefinition 是只暴露给 TypeScript Client 的最小 Provider 投影。
type clientDefinition struct {
	ID                string                 `json:"id"`
	Label             string                 `json:"label"`
	Short             string                 `json:"short"`
	TerminalIcon      string                 `json:"terminalIcon"`
	TerminalIconAsset string                 `json:"terminalIconAsset"`
	AccentVar         string                 `json:"accentVar"`
	SoftVar           string                 `json:"softVar"`
	TagColor          string                 `json:"tagColor"`
	Capabilities      []providers.Capability `json:"capabilities"`
	AuthOptions       []providers.AuthOption `json:"authOptions"`
	Clients           clientSupport          `json:"clients"`
}

// legacyCatalog 保持旧 Node 数据文件的扁平字段形状，迁移期由同一 Go 定义生成。
type legacyCatalog struct {
	Providers                  []providers.Presentation `json:"providers"`
	Fallback                   providers.Presentation   `json:"fallback"`
	DeprecatedGatewayProviders []string                 `json:"deprecatedGatewayProviders"`
}

func main() {
	// --check 只比较生成结果，不修改工作区，供测试和 CI 使用。
	check := flag.Bool("check", false, "只校验生成文件是否最新")
	root := flag.String("root", ".", "仓库根目录")
	flag.Parse()

	if err := run(*root, *check); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run 校验内置定义并生成所有跨语言投影。
func run(root string, check bool) error {
	manifest := providers.BuiltinManifest()
	if err := providers.ValidateManifest(manifest); err != nil {
		return fmt.Errorf("Provider 合同校验失败: %w", err)
	}

	manifestJSON, err := renderJSON(manifest)
	if err != nil {
		return fmt.Errorf("序列化 Provider 合同失败: %w", err)
	}
	legacyJSON, err := renderJSON(buildLegacyCatalog(manifest))
	if err != nil {
		return fmt.Errorf("生成旧版 Node Provider 投影失败: %w", err)
	}
	clientTypeScript, err := renderClientTypeScript(manifest)
	if err != nil {
		return fmt.Errorf("生成 TypeScript Provider 投影失败: %w", err)
	}
	clientJavaScript, err := renderClientJavaScript(manifest)
	if err != nil {
		return fmt.Errorf("生成 JavaScript Provider 投影失败: %w", err)
	}

	outputs := []outputFile{
		{RelativePath: "contracts/providers/manifest.json", Content: manifestJSON},
		// 旧路径暂时保留扁平兼容投影，避免现有外部脚本在迁移期突然失效。
		{RelativePath: "lib/provider-catalog-data.json", Content: legacyJSON},
		{RelativePath: "web/src/providers/provider-contract.generated.ts", Content: clientTypeScript},
		{RelativePath: "web/src/providers/provider-contract.generated.js", Content: clientJavaScript},
	}
	for _, output := range outputs {
		if err := syncOutput(root, output, check); err != nil {
			return err
		}
	}
	return nil
}

// buildClientDefinitions 只投影浏览器需要的展示、能力和认证字段。
func buildClientDefinitions(manifest providers.Manifest) []clientDefinition {
	definitions := make([]clientDefinition, 0, len(manifest.Providers))
	for _, definition := range manifest.Providers {
		presentation := definition.Presentation
		definitions = append(definitions, clientDefinition{
			ID:                definition.ID,
			Label:             presentation.Label,
			Short:             presentation.Short,
			TerminalIcon:      presentation.TerminalIcon,
			TerminalIconAsset: presentation.TerminalIconAsset,
			AccentVar:         presentation.AccentVar,
			SoftVar:           presentation.SoftVar,
			TagColor:          presentation.TagColor,
			Capabilities:      definition.Capabilities,
			AuthOptions:       definition.AuthOptions,
			Clients: clientSupport{
				CLI:     definition.Clients.CLI,
				Desktop: definition.Clients.Desktop,
			},
		})
	}
	return definitions
}

// buildLegacyCatalog 从完整合同派生旧版扁平展示目录，不引入第二份人工定义。
func buildLegacyCatalog(manifest providers.Manifest) legacyCatalog {
	legacy := legacyCatalog{
		Providers: make([]providers.Presentation, 0, len(manifest.Providers)),
		Fallback:  manifest.Fallback,
	}
	for _, definition := range manifest.Providers {
		legacy.Providers = append(legacy.Providers, definition.Presentation)
		if definition.Gateway == providers.GatewayDeprecated {
			legacy.DeprecatedGatewayProviders = append(legacy.DeprecatedGatewayProviders, definition.ID)
		}
	}
	return legacy
}

// renderJSON 使用稳定缩进和未转义 HTML 字符生成可审查的合同 JSON。
func renderJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// renderClientTypeScript 只投影 Client 需要的展示和认证字段，避免把 Server CLI 细节带进浏览器包。
func renderClientTypeScript(manifest providers.Manifest) ([]byte, error) {
	definitions := buildClientDefinitions(manifest)
	definitionsJSON, err := renderJSON(definitions)
	if err != nil {
		return nil, err
	}
	// Fallback 没有 CLI 定义，clients 固定为全 false，保持 ProviderCatalogEntry 形状一致。
	fallbackJSON, err := renderJSON(struct {
		providers.Presentation
		Capabilities []providers.Capability `json:"capabilities"`
		Clients      clientSupport          `json:"clients"`
	}{
		Presentation: manifest.Fallback,
		Capabilities: []providers.Capability{},
		Clients:      clientSupport{CLI: false, Desktop: false},
	})
	if err != nil {
		return nil, err
	}

	var output strings.Builder
	output.WriteString("/**\n")
	output.WriteString(" * 此文件由 `go run ./cmd/provider-manifest` 自动生成。\n")
	output.WriteString(" * 人工修改会在 Provider 合同校验中失败；请编辑 `core/providers/builtins.go`。\n")
	output.WriteString(" */\n\n")
	output.WriteString("export const PROVIDER_DEFINITIONS = ")
	output.Write(bytes.TrimSpace(definitionsJSON))
	output.WriteString(" as const;\n\n")
	output.WriteString("/** Provider 的稳定字符串身份。 */\n")
	output.WriteString("export type ProviderId = (typeof PROVIDER_DEFINITIONS)[number]['id'];\n\n")
	output.WriteString("/** Client 支持的账号认证方式。 */\n")
	output.WriteString("export type ProviderAuthMode = (typeof PROVIDER_DEFINITIONS)[number]['authOptions'][number]['value'];\n\n")
	output.WriteString("/** Client 展示的一条账号认证选项。 */\n")
	output.WriteString("export interface ProviderAuthOption {\n")
	output.WriteString("  readonly value: ProviderAuthMode;\n")
	output.WriteString("  readonly label: string;\n")
	output.WriteString("  readonly description: string;\n")
	output.WriteString("  readonly disabled?: boolean;\n")
	output.WriteString("  readonly disabledReason?: string;\n")
	output.WriteString("}\n\n")
	output.WriteString("/** Client 使用的 Provider 展示元数据。 */\n")
	output.WriteString("export interface ProviderCatalogEntry {\n")
	output.WriteString("  readonly id: ProviderId;\n")
	output.WriteString("  readonly label: string;\n")
	output.WriteString("  readonly short: string;\n")
	output.WriteString("  readonly terminalIcon: string;\n")
	output.WriteString("  readonly terminalIconAsset: string;\n")
	output.WriteString("  readonly accentVar: string;\n")
	output.WriteString("  readonly softVar: string;\n")
	output.WriteString("  readonly tagColor: string;\n")
	output.WriteString("  readonly capabilities: readonly string[];\n")
	output.WriteString("  readonly clients: { readonly cli: boolean; readonly desktop: boolean };\n")
	output.WriteString("}\n\n")
	output.WriteString("/** 按产品顺序排列的 Provider ID。 */\n")
	output.WriteString("export const PROVIDER_IDS = Object.freeze(PROVIDER_DEFINITIONS.map((definition) => definition.id));\n\n")
	output.WriteString("/** 由同一生成源构建的 Provider 展示目录。 */\n")
	output.WriteString("export const PROVIDER_CATALOG = Object.freeze(Object.fromEntries(\n")
	output.WriteString("  PROVIDER_DEFINITIONS.map((definition) => [definition.id, {\n")
	output.WriteString("    id: definition.id,\n")
	output.WriteString("    label: definition.label,\n")
	output.WriteString("    short: definition.short,\n")
	output.WriteString("    terminalIcon: definition.terminalIcon,\n")
	output.WriteString("    terminalIconAsset: definition.terminalIconAsset,\n")
	output.WriteString("    accentVar: definition.accentVar,\n")
	output.WriteString("    softVar: definition.softVar,\n")
	output.WriteString("    tagColor: definition.tagColor,\n")
	output.WriteString("    capabilities: definition.capabilities,\n")
	output.WriteString("    clients: definition.clients,\n")
	output.WriteString("  }]),\n")
	output.WriteString(") as Readonly<Record<ProviderId, ProviderCatalogEntry>>);\n\n")
	output.WriteString("/** 账号添加界面直接消费的认证选项目录。 */\n")
	output.WriteString("export const PROVIDER_AUTH_OPTIONS = Object.freeze(Object.fromEntries(\n")
	output.WriteString("  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition.authOptions]),\n")
	output.WriteString(") as Readonly<Record<ProviderId, readonly ProviderAuthOption[]>>);\n\n")
	output.WriteString("/** 未知 Provider 的安全展示回退。 */\n")
	output.WriteString("export const PROVIDER_FALLBACK = ")
	output.Write(bytes.TrimSpace(fallbackJSON))
	output.WriteString(" as const satisfies ProviderCatalogEntry;\n")
	return []byte(output.String()), nil
}

// renderClientJavaScript 生成 Node 测试和浏览器运行时代码都能直接加载的 ESM 投影。
// 数据仍来自同一 Provider 合同，避免运行时代码依赖 Umi 专用路径别名。
func renderClientJavaScript(manifest providers.Manifest) ([]byte, error) {
	definitionsJSON, err := renderJSON(buildClientDefinitions(manifest))
	if err != nil {
		return nil, err
	}
	fallbackJSON, err := renderJSON(struct {
		providers.Presentation
		Capabilities []providers.Capability `json:"capabilities"`
		Clients      clientSupport          `json:"clients"`
	}{
		Presentation: manifest.Fallback,
		Capabilities: []providers.Capability{},
		Clients:      clientSupport{CLI: false, Desktop: false},
	})
	if err != nil {
		return nil, err
	}

	var output strings.Builder
	output.WriteString("/**\n")
	output.WriteString(" * 此文件由 `go run ./cmd/provider-manifest` 自动生成。\n")
	output.WriteString(" * 人工修改会在 Provider 合同校验中失败；请编辑 `core/providers/builtins.go`。\n")
	output.WriteString(" */\n\n")
	output.WriteString("export const PROVIDER_DEFINITIONS = ")
	output.Write(bytes.TrimSpace(definitionsJSON))
	output.WriteString(";\n\n")
	output.WriteString("export const PROVIDER_IDS = Object.freeze(PROVIDER_DEFINITIONS.map((definition) => definition.id));\n\n")
	output.WriteString("export const PROVIDER_CATALOG = Object.freeze(Object.fromEntries(\n")
	output.WriteString("  PROVIDER_DEFINITIONS.map((definition) => [definition.id, {\n")
	output.WriteString("    id: definition.id,\n")
	output.WriteString("    label: definition.label,\n")
	output.WriteString("    short: definition.short,\n")
	output.WriteString("    terminalIcon: definition.terminalIcon,\n")
	output.WriteString("    terminalIconAsset: definition.terminalIconAsset,\n")
	output.WriteString("    accentVar: definition.accentVar,\n")
	output.WriteString("    softVar: definition.softVar,\n")
	output.WriteString("    tagColor: definition.tagColor,\n")
	output.WriteString("    capabilities: definition.capabilities,\n")
	output.WriteString("    clients: definition.clients,\n")
	output.WriteString("  }]),\n")
	output.WriteString("));\n\n")
	output.WriteString("export const PROVIDER_AUTH_OPTIONS = Object.freeze(Object.fromEntries(\n")
	output.WriteString("  PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition.authOptions]),\n")
	output.WriteString("));\n\n")
	output.WriteString("export const PROVIDER_FALLBACK = ")
	output.Write(bytes.TrimSpace(fallbackJSON))
	output.WriteString(";\n")
	return []byte(output.String()), nil
}

// syncOutput 根据模式写入文件或验证文件内容完全一致。
func syncOutput(root string, output outputFile, check bool) error {
	target := filepath.Join(root, filepath.FromSlash(output.RelativePath))
	if check {
		current, err := os.ReadFile(target)
		if err != nil {
			return fmt.Errorf("读取生成文件失败 %s: %w", output.RelativePath, err)
		}
		if !bytes.Equal(current, output.Content) {
			return fmt.Errorf("生成文件已过期: %s；请运行 go generate ./core/providers", output.RelativePath)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("创建生成目录失败 %s: %w", output.RelativePath, err)
	}
	current, err := os.ReadFile(target)
	if err == nil && bytes.Equal(current, output.Content) {
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("读取已有生成文件失败 %s: %w", output.RelativePath, err)
	}
	if err := os.WriteFile(target, output.Content, 0o644); err != nil {
		return fmt.Errorf("写入生成文件失败 %s: %w", output.RelativePath, err)
	}
	fmt.Printf("已生成 %s\n", output.RelativePath)
	return nil
}
