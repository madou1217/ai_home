package providerconfigs

import (
	"embed"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
)

//go:embed schemas/*.json
var embeddedSchemasFS embed.FS

// SchemaField 描述单个配置键的文档元数据及兼容性边界。
type SchemaField struct {
	Path        string   `json:"path"`
	Type        string   `json:"type,omitempty"`
	TypeLabel   string   `json:"typeLabel,omitempty"`
	Description string   `json:"description,omitempty"`
	Topic       string   `json:"topic,omitempty"`
	Scope       string   `json:"scope,omitempty"`
	Default     any      `json:"default,omitempty"`
	Options     any      `json:"options,omitempty"`
	Secret      bool     `json:"secret,omitempty"`
	Deprecated  bool     `json:"deprecated,omitempty"`
	Since       string   `json:"since,omitempty"`
	RemovedIn   string   `json:"removedIn,omitempty"`
}

// ConfigSchema 描述一份配置文件的离线官方字段说明快照。
type ConfigSchema struct {
	ID                 string        `json:"id"`
	Title              string        `json:"title"`
	Source             string        `json:"source"`
	SourceURL          string        `json:"sourceUrl"`
	DocsURL            string        `json:"docsUrl"`
	VerifiedAt         string        `json:"verifiedAt"`
	VerifiedCLIVersion string        `json:"verifiedCliVersion"`
	Sensitive          bool          `json:"sensitive,omitempty"`
	FieldCount         int           `json:"fieldCount"`
	Fields             []SchemaField `json:"fields"`
}

// FieldCompatibility 表示配置字段相对本机 CLI 版本的兼容性结论。
type FieldCompatibility struct {
	State    string   `json:"state"`
	Messages []string `json:"messages"`
}

// AnnotatedSchemaField 在离线字段元数据上叠加 CLI 等价旗标与兼容性。
type AnnotatedSchemaField struct {
	Path          string              `json:"path"`
	Type          string              `json:"type,omitempty"`
	TypeLabel     string              `json:"typeLabel,omitempty"`
	Description   string              `json:"description,omitempty"`
	Topic         string              `json:"topic,omitempty"`
	Scope         string              `json:"scope,omitempty"`
	Default       any                 `json:"default,omitempty"`
	Options       any                 `json:"options,omitempty"`
	Secret        bool                `json:"secret,omitempty"`
	Deprecated    bool                `json:"deprecated,omitempty"`
	Since         string              `json:"since,omitempty"`
	RemovedIn     string              `json:"removedIn,omitempty"`
	CLIFlag       string              `json:"cliFlag,omitempty"`
	CLISample     string              `json:"cliSample,omitempty"`
	Compatibility FieldCompatibility  `json:"compatibility"`
}

// CompatibilityWarning 记录一条弃用或不兼容字段提醒。
type CompatibilityWarning struct {
	Path     string   `json:"path"`
	State    string   `json:"state"`
	Messages []string `json:"messages"`
}

// AnnotatedSchema 返回包含字段等价参数与兼容提示的完整 Schema 视图。
type AnnotatedSchema struct {
	ID                    string                 `json:"id"`
	Title                 string                 `json:"title"`
	Source                string                 `json:"source"`
	SourceURL             string                 `json:"sourceUrl"`
	DocsURL               string                 `json:"docsUrl"`
	VerifiedAt            string                 `json:"verifiedAt"`
	VerifiedCLIVersion    string                 `json:"verifiedCliVersion"`
	Sensitive             bool                   `json:"sensitive"`
	FieldCount            int                    `json:"fieldCount"`
	Fields                []AnnotatedSchemaField `json:"fields"`
	CompatibilityWarnings []CompatibilityWarning `json:"compatibilityWarnings"`
}

// SchemaVersionStatus 描述校对版本与已安装 CLI 版本的差异提示。
type SchemaVersionStatus struct {
	Verified       string `json:"verified"`
	Installed      string `json:"installed"`
	Mismatch       bool   `json:"mismatch"`
	InstalledNewer bool   `json:"installedNewer,omitempty"`
	Message        string `json:"message"`
}

var (
	schemaCatalog = map[string]*ConfigSchema{}
	reSemverParts = regexp.MustCompile(`(\d+)(?:\.(\d+))?(?:\.(\d+))?`)
)

func init() {
	entries, err := embeddedSchemasFS.ReadDir("schemas")
	if err != nil {
		panic(fmt.Sprintf("读取内嵌配置 schema 失败: %v", err))
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := embeddedSchemasFS.ReadFile(path.Join("schemas", entry.Name()))
		if err != nil {
			panic(fmt.Sprintf("读取配置 schema %s 失败: %v", entry.Name(), err))
		}
		var s ConfigSchema
		if err := json.Unmarshal(raw, &s); err != nil {
			panic(fmt.Sprintf("解析配置 schema %s 失败: %v", entry.Name(), err))
		}
		if s.Fields == nil {
			s.Fields = []SchemaField{}
		}
		s.FieldCount = len(s.Fields)
		schemaCatalog[s.ID] = &s
	}
}

// GetConfigSchema 按 schemaId 返回内嵌离线字段说明。
func GetConfigSchema(schemaID string) *ConfigSchema {
	key := strings.TrimSpace(schemaID)
	s, ok := schemaCatalog[key]
	if !ok {
		return nil
	}
	cp := *s
	return &cp
}

// NormalizeSchemaPath 规范化嵌套配置键路径，便于精确或回退匹配。
func NormalizeSchemaPath(value string) string {
	v := strings.TrimSpace(value)
	v = strings.Trim(v, "[]")
	v = strings.Trim(v, ".")
	v = strings.ReplaceAll(v, " ", "")
	v = strings.ReplaceAll(v, "\t", "")
	return v
}

func parseVersionParts(value string) ([3]int, bool) {
	m := reSemverParts.FindStringSubmatch(strings.TrimSpace(value))
	if m == nil {
		return [3]int{}, false
	}
	var parts [3]int
	for i := 0; i < 3; i++ {
		if m[i+1] != "" {
			parts[i], _ = strconv.Atoi(m[i+1])
		}
	}
	return parts, true
}

// CompareVersions 按三段主次修订号比较两个版本串，无法解析返回 (0, false)。
func CompareVersions(left, right string) (int, bool) {
	a, okA := parseVersionParts(left)
	b, okB := parseVersionParts(right)
	if !okA || !okB {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			if a[i] > b[i] {
				return 1, true
			}
			return -1, true
		}
	}
	return 0, true
}

// EvaluateFieldCompatibility 校验单字段在指定 CLI 版本下是否已移除或尚未支持。
func EvaluateFieldCompatibility(field SchemaField, cliVersion string) FieldCompatibility {
	res := FieldCompatibility{State: "ok", Messages: []string{}}
	if field.Deprecated {
		res.State = "deprecated"
		res.Messages = append(res.Messages, "该配置已被标记为弃用，新版本可能不再生效。")
	}
	installed := strings.TrimSpace(cliVersion)
	if installed != "" {
		if field.RemovedIn != "" {
			if cmp, ok := CompareVersions(installed, field.RemovedIn); ok && cmp >= 0 {
				return FieldCompatibility{
					State:    "unsupported",
					Messages: []string{fmt.Sprintf("当前 CLI %s 已移除该配置（removedIn %s）。", installed, field.RemovedIn)},
				}
			}
		}
		if field.Since != "" {
			if cmp, ok := CompareVersions(installed, field.Since); ok && cmp < 0 {
				return FieldCompatibility{
					State:    "unsupported",
					Messages: []string{fmt.Sprintf("该配置从 CLI %s 起才支持，当前为 %s。", field.Since, installed)},
				}
			}
		}
	}
	return res
}

func annotateSchema(schema *ConfigSchema, cliVersion string, equivalents map[string]CLIEquivalent) *AnnotatedSchema {
	if schema == nil {
		return nil
	}
	docsURL := schema.DocsURL
	if docsURL == "" {
		docsURL = schema.SourceURL
	}
	fields := make([]AnnotatedSchemaField, 0, len(schema.Fields))
	warnings := make([]CompatibilityWarning, 0)
	for _, f := range schema.Fields {
		compat := EvaluateFieldCompatibility(f, cliVersion)
		eq := equivalents[f.Path]
		af := AnnotatedSchemaField{
			Path:          f.Path,
			Type:          f.Type,
			TypeLabel:     f.TypeLabel,
			Description:   f.Description,
			Topic:         f.Topic,
			Scope:         f.Scope,
			Default:       f.Default,
			Options:       f.Options,
			Secret:        f.Secret,
			Deprecated:    f.Deprecated,
			Since:         f.Since,
			RemovedIn:     f.RemovedIn,
			CLIFlag:       eq.Flag,
			CLISample:     eq.Sample,
			Compatibility: compat,
		}
		fields = append(fields, af)
		if compat.State != "ok" && len(warnings) < 50 {
			warnings = append(warnings, CompatibilityWarning{
				Path:     f.Path,
				State:    compat.State,
				Messages: compat.Messages,
			})
		}
	}
	return &AnnotatedSchema{
		ID:                    schema.ID,
		Title:                 schema.Title,
		Source:                schema.Source,
		SourceURL:             schema.SourceURL,
		DocsURL:               docsURL,
		VerifiedAt:            schema.VerifiedAt,
		VerifiedCLIVersion:    schema.VerifiedCLIVersion,
		Sensitive:             schema.Sensitive,
		FieldCount:            len(schema.Fields),
		Fields:                fields,
		CompatibilityWarnings: warnings,
	}
}

func computeSchemaVersionStatus(schema *ConfigSchema, cli CLIInfo) *SchemaVersionStatus {
	if schema == nil {
		return nil
	}
	verified := strings.TrimSpace(schema.VerifiedCLIVersion)
	installed := strings.TrimSpace(cli.Version)
	if verified == "" || installed == "" {
		return &SchemaVersionStatus{
			Verified:  verified,
			Installed: installed,
		}
	}
	cmp, ok := CompareVersions(installed, verified)
	if !ok || cmp == 0 {
		return &SchemaVersionStatus{
			Verified:  verified,
			Installed: installed,
		}
	}
	var msg string
	if cmp > 0 {
		msg = fmt.Sprintf("字段说明按 CLI %s 校对，当前安装的是 %s；新版本可能新增或改动字段，未收录的键会回退到父级说明。", verified, installed)
	} else {
		msg = fmt.Sprintf("字段说明按 CLI %s 校对，当前安装的是 %s；该说明可能包含当前版本尚未支持的字段。", verified, installed)
	}
	return &SchemaVersionStatus{
		Verified:       verified,
		Installed:      installed,
		Mismatch:       true,
		InstalledNewer: cmp > 0,
		Message:        msg,
	}
}
