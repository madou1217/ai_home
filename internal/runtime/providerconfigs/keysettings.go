package providerconfigs

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/providersettings"
)

// ChoiceResolver 把模型目录事实翻译成关键设置的可选值。
//
// 实现由组合根注入：WebUI 服务持有模型快照与推理档位目录，配置服务本身
// 不直连账号库或探测上游。
type ChoiceResolver interface {
	// ModelIDs 返回当前账号目录里可用的模型（真实可路由）。
	ModelIDs(ctx context.Context, provider string) []string
	// CatalogModelIDs 返回 Provider 官方/别名目录里的模型；其中可能没有账号。
	CatalogModelIDs(ctx context.Context, provider string) []string
	ReasoningEfforts(provider string, model string) []string
}

// KeySettingValue 是单个关键设置的读取结果。
type KeySettingValue struct {
	Path    string   `json:"path"`
	Label   string   `json:"label"`
	Kind    string   `json:"kind"`
	Value   string   `json:"value"`
	Choices []string `json:"choices,omitempty"`
	// UnavailableChoices 是官方目录里有、但当前账号目录里没有的模型（UI 标记“无账号”）。
	UnavailableChoices []string `json:"unavailableChoices,omitempty"`
	Placeholder        string   `json:"placeholder,omitempty"`
	Help               string   `json:"help,omitempty"`
	DependsOn          string   `json:"dependsOn,omitempty"`
	Min                float64  `json:"min,omitempty"`
	Max                float64  `json:"max,omitempty"`
	Step               float64  `json:"step,omitempty"`
	Default            string   `json:"default,omitempty"`
}

// KeySettingsResponse 对应 GET .../key-settings 响应。
type KeySettingsResponse struct {
	OK       bool              `json:"ok"`
	Provider string            `json:"provider"`
	FileID   string            `json:"fileId"`
	Format   string            `json:"format"`
	Revision string            `json:"revision"`
	Writable bool              `json:"writable"`
	Settings []KeySettingValue `json:"settings"`
	// Scope 是 public（公共配置文件）或 account（账号级覆盖视图）。
	Scope string `json:"scope"`
	// AccountRef 只在账号视图出现。
	AccountRef string `json:"accountRef,omitempty"`
	// PublicValues 是账号视图中每项的公共值；Overrides 是账号显式覆盖的键。
	PublicValues map[string]string `json:"publicValues,omitempty"`
	Overrides    map[string]string `json:"overrides,omitempty"`
	// AccountLaunchSupported 表示该 Provider 的账号覆盖会在启动时注入。
	AccountLaunchSupported bool `json:"accountLaunchSupported,omitempty"`
}

// AccountKeySettingsSaveResponse 是账号级覆盖保存结果。
type AccountKeySettingsSaveResponse struct {
	OK         bool              `json:"ok"`
	Provider   string            `json:"provider"`
	FileID     string            `json:"fileId"`
	AccountRef string            `json:"accountRef"`
	Changed    bool              `json:"changed"`
	Revision   string            `json:"revision"`
	Overrides  map[string]string `json:"overrides"`
}

// ReadKeySettings 读取配置文件里的关键设置，并按目录事实补齐候选值。
//
// modelOverride 用于表单里尚未保存的模型选择：推理档位应按它取，
// 而不是按文件里上一次保存的模型。
func (s *Service) ReadKeySettings(ctx context.Context, provider, fileID, modelOverride string) (*KeySettingsResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	response := &KeySettingsResponse{
		OK:       true,
		Provider: rf.Definition.Provider,
		FileID:   rf.Definition.ID,
		Format:   rf.Public.Format,
		Writable: rf.Writable,
		Scope:    "public",
	}
	if len(rf.Definition.KeySettings) == 0 {
		return response, nil
	}
	content, revision, _, _, err := readTargetContent(rf)
	if err != nil {
		return nil, err
	}
	response.Revision = revision
	values := ReadKeyValues(content, rf.Public.Format, rf.Definition.KeySettings)
	for _, setting := range rf.Definition.KeySettings {
		view := KeySettingValue{
			Path:        setting.Path,
			Label:       setting.Label,
			Kind:        string(setting.Kind),
			Value:       values[setting.Path],
			Choices:     append([]string(nil), setting.Choices...),
			Placeholder: setting.Placeholder,
			Help:        setting.Help,
			DependsOn:   setting.DependsOn,
			Min:         setting.Min,
			Max:         setting.Max,
			Step:        setting.Step,
			Default:     setting.Default,
		}
		view.Choices, view.UnavailableChoices = s.resolveKeySettingChoices(ctx, rf.Definition.Provider, setting, values, modelOverride)
		response.Settings = append(response.Settings, view)
	}
	return response, nil
}

// ReadAccountKeySettings 返回账号视图：公共值 + 账号覆盖 + 合成后的有效值。
func (s *Service) ReadAccountKeySettings(
	ctx context.Context,
	provider, fileID, modelOverride, accountRef string,
) (*KeySettingsResponse, error) {
	if s.accountSettings == nil {
		return nil, &ConfigError{Code: "provider_config_account_settings_unavailable", Message: "账号级 Provider 设置存储不可用"}
	}
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	normalizedProvider := strings.ToLower(strings.TrimSpace(rf.Definition.Provider))
	if err := s.assertAccountProvider(ctx, normalizedProvider, accountRef); err != nil {
		return nil, err
	}
	response := &KeySettingsResponse{
		OK:                     true,
		Provider:               rf.Definition.Provider,
		FileID:                 rf.Definition.ID,
		Format:                 rf.Public.Format,
		Writable:               true,
		Scope:                  "account",
		AccountRef:             strings.TrimSpace(accountRef),
		Overrides:              map[string]string{},
		AccountLaunchSupported: AccountLaunchInjectionSupported(normalizedProvider),
	}
	if len(rf.Definition.KeySettings) == 0 {
		return response, nil
	}
	content, revision, _, _, err := readTargetContent(rf)
	if err != nil {
		return nil, err
	}
	response.Revision = revision
	publicValues := ReadKeyValues(content, rf.Public.Format, rf.Definition.KeySettings)
	declared := make(map[string]struct{}, len(rf.Definition.KeySettings))
	for _, setting := range rf.Definition.KeySettings {
		declared[setting.Path] = struct{}{}
	}
	document, err := s.accountSettings.Read(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	overrides := map[string]string{}
	if document.Provider == normalizedProvider {
		for path, value := range document.Values {
			if _, ok := declared[path]; ok && strings.TrimSpace(value) != "" {
				overrides[path] = strings.TrimSpace(value)
			}
		}
	}
	effective := providersettings.Effective(publicValues, overrides)
	response.PublicValues = publicValues
	response.Overrides = overrides
	for _, setting := range rf.Definition.KeySettings {
		view := KeySettingValue{
			Path:        setting.Path,
			Label:       setting.Label,
			Kind:        string(setting.Kind),
			Value:       effective[setting.Path],
			Choices:     append([]string(nil), setting.Choices...),
			Placeholder: setting.Placeholder,
			Help:        setting.Help,
			DependsOn:   setting.DependsOn,
			Min:         setting.Min,
			Max:         setting.Max,
			Step:        setting.Step,
			Default:     setting.Default,
		}
		view.Choices, view.UnavailableChoices = s.resolveKeySettingChoices(ctx, normalizedProvider, setting, effective, modelOverride)
		response.Settings = append(response.Settings, view)
	}
	return response, nil
}

// SaveAccountKeySettings 只保存账号级覆盖；空值表示移除覆盖、恢复公共值。
func (s *Service) SaveAccountKeySettings(
	ctx context.Context,
	provider, fileID, accountRef string,
	values map[string]string,
) (*AccountKeySettingsSaveResponse, error) {
	if s.accountSettings == nil {
		return nil, &ConfigError{Code: "provider_config_account_settings_unavailable", Message: "账号级 Provider 设置存储不可用"}
	}
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	normalizedProvider := strings.ToLower(strings.TrimSpace(rf.Definition.Provider))
	ref := strings.TrimSpace(accountRef)
	if err := s.assertAccountProvider(ctx, normalizedProvider, ref); err != nil {
		return nil, err
	}
	if len(rf.Definition.KeySettings) == 0 {
		return nil, &ConfigError{Code: "provider_config_key_settings_unsupported", Message: "该配置文件没有可编辑的关键设置"}
	}
	declared := make(map[string]KeySetting, len(rf.Definition.KeySettings))
	for _, setting := range rf.Definition.KeySettings {
		declared[setting.Path] = setting
	}
	current, err := s.accountSettings.Read(ctx, ref)
	if err != nil {
		return nil, err
	}
	beforeValues := providersettings.Values{}
	if current.Provider == normalizedProvider {
		for path, value := range current.Values {
			if _, ok := declared[path]; ok {
				beforeValues[path] = value
			}
		}
	}
	next := providersettings.Values{}
	for path, value := range beforeValues {
		next[path] = value
	}
	for path, value := range values {
		setting, ok := declared[path]
		if !ok {
			return nil, &ConfigError{Code: "provider_config_key_setting_unknown", Message: "未声明的关键设置: " + path}
		}
		text := strings.TrimSpace(value)
		if text == "" {
			delete(next, path)
			continue
		}
		if err := validateKeySettingValue(setting, text); err != nil {
			return nil, &ConfigError{Code: "provider_config_key_setting_invalid", Message: err.Error()}
		}
		next[path] = text
	}
	before, err := json.Marshal(beforeValues)
	if err != nil {
		return nil, err
	}
	document, err := s.accountSettings.Write(ctx, ref, normalizedProvider, next)
	if err != nil {
		return nil, err
	}
	after, err := json.Marshal(document.Values)
	if err != nil {
		return nil, err
	}
	return &AccountKeySettingsSaveResponse{
		OK:         true,
		Provider:   rf.Definition.Provider,
		FileID:     rf.Definition.ID,
		AccountRef: ref,
		Changed:    string(before) != string(after),
		Revision:   hashSHA256(string(after)),
		Overrides:  document.Values,
	}, nil
}

// assertAccountProvider 校验账号存在且属于该 Provider。
func (s *Service) assertAccountProvider(ctx context.Context, provider, accountRef string) error {
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return &ConfigError{Code: "provider_config_account_required", Message: "缺少账号引用"}
	}
	if strings.TrimSpace(s.aiHomeDir) == "" {
		return &ConfigError{Code: "provider_config_account_settings_unavailable", Message: "账号级 Provider 设置存储不可用"}
	}
	databasePath, err := appstate.DatabasePath(s.aiHomeDir)
	if err != nil {
		return &ConfigError{Code: "provider_config_account_settings_unavailable", Message: "账号级 Provider 设置存储不可用"}
	}
	storedProvider, found, err := appstate.LookupAccountProvider(ctx, databasePath, ref)
	if err != nil {
		return &ConfigError{Code: "provider_config_account_lookup_failed", Message: "查询账号失败"}
	}
	if !found {
		return &ConfigError{Code: "provider_config_account_not_found", Message: "未找到该账号"}
	}
	if strings.ToLower(strings.TrimSpace(storedProvider)) != provider {
		return &ConfigError{Code: "provider_config_account_provider_mismatch", Message: "账号不属于该 Provider"}
	}
	return nil
}

// validateKeySettingValue 在写入账号覆盖前按声明校验取值类型与范围。
func validateKeySettingValue(setting KeySetting, value string) error {
	if strings.ContainsAny(value, "\r\n\x00") || len(value) > 4096 {
		return fmt.Errorf("关键设置 %s 取值无效", setting.Path)
	}
	switch setting.Kind {
	case KeySettingBoolean:
		lower := strings.ToLower(value)
		if lower != "true" && lower != "false" {
			return fmt.Errorf("关键设置 %s 必须是 true/false", setting.Path)
		}
	case KeySettingNumber:
		if _, err := encodeNumber(setting, value); err != nil {
			return err
		}
	}
	return nil
}

// SaveKeySettings 只更新声明过的关键键，保存仍走同一份 revision/校验/历史路径。
func (s *Service) SaveKeySettings(
	ctx context.Context,
	provider, fileID string,
	values map[string]string,
	expectedRevision string,
) (*SaveResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	if len(rf.Definition.KeySettings) == 0 {
		return nil, &ConfigError{Code: "provider_config_key_settings_unsupported", Message: "该配置文件没有可编辑的关键设置"}
	}
	if len(values) == 0 {
		return nil, &ConfigError{Code: "provider_config_key_settings_required", Message: "至少提供一个关键设置"}
	}
	declared := make(map[string]KeySetting, len(rf.Definition.KeySettings))
	for _, setting := range rf.Definition.KeySettings {
		declared[setting.Path] = setting
	}
	paths := make([]string, 0, len(values))
	for path := range values {
		if _, ok := declared[path]; !ok {
			return nil, &ConfigError{Code: "provider_config_key_setting_unknown", Message: "未声明的关键设置: " + path}
		}
		paths = append(paths, path)
	}
	sort.Strings(paths)
	content, revision, _, _, err := readTargetContent(rf)
	if err != nil {
		return nil, err
	}
	if expected := strings.TrimSpace(expectedRevision); expected != "" && expected != revision {
		return nil, &ConfigError{Code: "provider_config_conflict", Message: "配置文件在编辑期间已被其他进程修改，请重新读取后再保存"}
	}
	patched, err := PatchKeyValues(content, rf.Public.Format, rf.Definition.KeySettings, values)
	if err != nil {
		return nil, &ConfigError{Code: "provider_config_key_setting_invalid", Message: err.Error()}
	}
	return s.SaveFile(ctx, provider, fileID, patched, SaveOptions{
		ExpectedRevision: expectedRevision,
		Note:             "关键设置更新: " + strings.Join(paths, ", "),
	})
}

func (s *Service) resolveKeySettingChoices(
	ctx context.Context,
	provider string,
	setting KeySetting,
	values map[string]string,
	modelOverride string,
) (choices []string, unavailable []string) {
	switch setting.Kind {
	case KeySettingModel:
		if s.choices == nil {
			return nil, nil
		}
		available := s.choices.ModelIDs(ctx, provider)
		catalog := s.choices.CatalogModelIDs(ctx, provider)
		availableSet := make(map[string]struct{}, len(available))
		for _, id := range available {
			availableSet[id] = struct{}{}
		}
		for _, id := range catalog {
			if _, ok := availableSet[id]; !ok {
				unavailable = append(unavailable, id)
			}
		}
		return available, unavailable
	case KeySettingReasoningEffort:
		if s.choices == nil {
			return nil, nil
		}
		model := strings.TrimSpace(modelOverride)
		if model == "" {
			dependsOn := setting.DependsOn
			if dependsOn == "" {
				dependsOn = "model"
			}
			model = strings.TrimSpace(values[dependsOn])
		}
		if model == "" {
			return nil, nil
		}
		return s.choices.ReasoningEfforts(provider, model), nil
	default:
		return append([]string(nil), setting.Choices...), nil
	}
}

// ReadKeyValues 按文件格式读取关键键的当前值；缺失返回空串。
func ReadKeyValues(content, format string, settings []KeySetting) map[string]string {
	values := make(map[string]string, len(settings))
	for _, setting := range settings {
		values[setting.Path] = readKeyValue(content, format, setting.Path)
	}
	return values
}

func readKeyValue(content, format, path string) string {
	segments := strings.Split(path, ".")
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "toml":
		statement, found := findTOMLSetting(content, segments)
		if !found {
			return ""
		}
		return tomlScalarString(statement.Value)
	case "json", "jsonc":
		start, end, found := findJSONValueSpan(content, segments)
		if !found {
			return ""
		}
		return jsonSpanString(content[start:end])
	default:
		return ""
	}
}

// PatchKeyValues 把声明过的关键设置写回原文，只改动目标键的文本区间。
func PatchKeyValues(content, format string, settings []KeySetting, values map[string]string) (string, error) {
	declared := make(map[string]KeySetting, len(settings))
	for _, setting := range settings {
		declared[setting.Path] = setting
	}
	paths := make([]string, 0, len(values))
	for path := range values {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	normalizedFormat := strings.ToLower(strings.TrimSpace(format))
	patched := content
	// 文件尚未创建时，JSON 从空对象开始；TOML 的空文档天然可写根级键。
	if strings.TrimSpace(patched) == "" && (normalizedFormat == "json" || normalizedFormat == "jsonc") {
		patched = "{}\n"
	}
	for _, path := range paths {
		setting := declared[path]
		value := strings.TrimSpace(values[path])
		var err error
		if value == "" {
			// 空值 = 清除覆盖，恢复文件/模型的默认行为。
			switch normalizedFormat {
			case "toml":
				patched, err = removeTOMLValue(patched, setting.Path)
			case "json", "jsonc":
				patched, err = removeJSONValue(patched, setting.Path)
			default:
				err = fmt.Errorf("配置格式 %s 暂不支持关键设置编辑", format)
			}
		} else {
			switch normalizedFormat {
			case "toml":
				patched, err = patchTOMLValue(patched, setting, value)
			case "json", "jsonc":
				patched, err = patchJSONValue(patched, setting, value)
			default:
				err = fmt.Errorf("配置格式 %s 暂不支持关键设置编辑", format)
			}
		}
		if err != nil {
			return "", err
		}
	}
	return patched, nil
}

func tomlScalarString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return fmt.Sprint(value)
	}
}

func jsonSpanString(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, `"`) {
		var decoded string
		if json.Unmarshal([]byte(trimmed), &decoded) == nil {
			return decoded
		}
		return ""
	}
	return trimmed
}

// patchTOMLValue 重写标量值（支持根级点号键与 [table] 成员），保留注释与结构。
func patchTOMLValue(content string, setting KeySetting, value string) (string, error) {
	segments := strings.Split(setting.Path, ".")
	encoded, err := encodeKeyValue(setting, value)
	if err != nil {
		return "", err
	}
	statements, err := ScanTOMLStatements(content)
	if err != nil {
		return "", err
	}
	for _, statement := range statements {
		if tomlStatementMatches(statement, segments) {
			return content[:statement.ValueStart] + encoded + content[statement.ValueEnd:], nil
		}
	}
	return insertTOMLSetting(content, segments, encoded), nil
}

// findTOMLSetting 匹配两种写法：[table] 成员与根级点号键。
func findTOMLSetting(content string, segments []string) (TOMLStatement, bool) {
	statements, err := ScanTOMLStatements(content)
	if err != nil {
		return TOMLStatement{}, false
	}
	for _, statement := range statements {
		if tomlStatementMatches(statement, segments) {
			return statement, true
		}
	}
	return TOMLStatement{}, false
}

func tomlStatementMatches(statement TOMLStatement, segments []string) bool {
	if statement.Table || len(segments) == 0 {
		return false
	}
	if len(statement.TablePath) == 0 && len(statement.Keys) == len(segments) {
		return equalStringSlices(statement.Keys, segments)
	}
	if len(segments) > 1 && len(statement.Keys) == 1 &&
		equalStringSlices(statement.TablePath, segments[:len(segments)-1]) {
		return statement.Keys[0] == segments[len(segments)-1]
	}
	return false
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// insertTOMLSetting 优先写进已存在的父表；没有父表时在文末新建。
func insertTOMLSetting(content string, segments []string, encoded string) string {
	if len(segments) == 1 {
		return segments[0] + " = " + encoded + "\n" + content
	}
	statements, err := ScanTOMLStatements(content)
	if err == nil {
		prefix := segments[:len(segments)-1]
		lastKey := segments[len(segments)-1]
		for _, statement := range statements {
			if statement.Table && equalStringSlices(statement.Keys, prefix) {
				// 表成员插在表头之后，位于下一张表之前。
				insertAt := statement.End
				return content[:insertAt] + lastKey + " = " + encoded + "\n" + content[insertAt:]
			}
		}
		// 根级点号键写法可读且不会与后续表冲突。
		for _, statement := range statements {
			if statement.Table {
				continue
			}
			if len(statement.Keys) > 0 && statement.Keys[0] == prefix[0] {
				return strings.Join(segments, ".") + " = " + encoded + "\n" + content
			}
		}
	}
	separator := ""
	if content != "" && !strings.HasSuffix(content, "\n") {
		separator = "\n"
	}
	table := "[" + strings.Join(segments[:len(segments)-1], ".") + "]"
	return content + separator + "\n" + table + "\n" + segments[len(segments)-1] + " = " + encoded + "\n"
}

func encodeKeyValue(setting KeySetting, value string) (string, error) {
	switch setting.Kind {
	case KeySettingBoolean:
		switch strings.ToLower(value) {
		case "true":
			return "true", nil
		case "false":
			return "false", nil
		default:
			return "", fmt.Errorf("关键设置 %s 必须是 true/false", setting.Path)
		}
	case KeySettingNumber:
		return encodeNumber(setting, value)
	default:
		return strconv.Quote(value), nil
	}
}

// encodeNumber 校验数值范围并按 JSON/TOML 共用的裸数字形式输出。
func encodeNumber(setting KeySetting, value string) (string, error) {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil {
		return "", fmt.Errorf("关键设置 %s 必须是数字", setting.Path)
	}
	if setting.Min != 0 && number < setting.Min {
		return "", fmt.Errorf("关键设置 %s 不能小于 %s", setting.Path, strconv.FormatFloat(setting.Min, 'f', -1, 64))
	}
	if setting.Max != 0 && number > setting.Max {
		return "", fmt.Errorf("关键设置 %s 不能大于 %s", setting.Path, strconv.FormatFloat(setting.Max, 'f', -1, 64))
	}
	return strconv.FormatFloat(number, 'f', -1, 64), nil
}

// findJSONValueSpan 返回点号路径对应值在原文中的字节区间，支持 JSONC 注释。
func findJSONValueSpan(content string, path []string) (int, int, bool) {
	if len(path) == 0 {
		return 0, 0, false
	}
	start := skipJSONCWhitespaceAndComments(content, 0)
	if start >= len(content) || content[start] != '{' {
		return 0, 0, false
	}
	return findJSONInObject(content, start, path)
}

func findJSONInObject(content string, objectStart int, path []string) (int, int, bool) {
	index := objectStart + 1
	for {
		index = skipJSONCWhitespaceAndComments(content, index)
		if index >= len(content) || content[index] == '}' {
			return 0, 0, false
		}
		if content[index] == ',' {
			index++
			continue
		}
		key, next, ok := scanJSONString(content, index)
		if !ok {
			return 0, 0, false
		}
		index = skipJSONCWhitespaceAndComments(content, next)
		if index >= len(content) || content[index] != ':' {
			return 0, 0, false
		}
		valueStart := skipJSONCWhitespaceAndComments(content, index+1)
		valueEnd, ok := skipJSONValue(content, valueStart)
		if !ok {
			return 0, 0, false
		}
		if key == path[0] {
			if len(path) == 1 {
				return valueStart, valueEnd, true
			}
			if valueStart < len(content) && content[valueStart] == '{' {
				return findJSONInObject(content, valueStart, path[1:])
			}
			return 0, 0, false
		}
		index = valueEnd
	}
}

// patchJSONValue 只替换/插入目标键的文本区间，保留其余内容与注释。
func patchJSONValue(content string, setting KeySetting, value string) (string, error) {
	encoded, err := encodeJSONKeyValue(setting, value)
	if err != nil {
		return "", err
	}
	path := strings.Split(setting.Path, ".")
	if start, end, found := findJSONValueSpan(content, path); found {
		return content[:start] + encoded + content[end:], nil
	}
	return insertJSONValue(content, path, encoded)
}

func encodeJSONKeyValue(setting KeySetting, value string) (string, error) {
	switch setting.Kind {
	case KeySettingBoolean:
		switch strings.ToLower(value) {
		case "true":
			return "true", nil
		case "false":
			return "false", nil
		default:
			return "", fmt.Errorf("关键设置 %s 必须是 true/false", setting.Path)
		}
	case KeySettingNumber:
		return encodeNumber(setting, value)
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return "", fmt.Errorf("关键设置 %s 取值无效", setting.Path)
		}
		return string(raw), nil
	}
}

func insertJSONValue(content string, path []string, encoded string) (string, error) {
	rootStart := skipJSONCWhitespaceAndComments(content, 0)
	if rootStart >= len(content) || content[rootStart] != '{' {
		return "", fmt.Errorf("配置文件不是 JSON 对象")
	}
	if len(path) == 1 {
		return insertJSONMember(content, rootStart, path[0], encoded)
	}
	// 父对象存在则递归插入；否则整体创建缺失的父链。
	start, _, found := findJSONValueSpan(content, path[:1])
	if found {
		if content[start] != '{' {
			return "", fmt.Errorf("关键设置 %s 的父级不是对象", path[0])
		}
		end, ok := skipJSONValue(content, start)
		if !ok {
			return "", fmt.Errorf("无法解析 JSON 对象")
		}
		patched, err := insertJSONValue(content[start:end], path[1:], encoded)
		if err != nil {
			return "", err
		}
		return content[:start] + patched + content[end:], nil
	}
	value := encoded
	for index := len(path) - 1; index >= 1; index-- {
		value = "{" + strconv.Quote(path[index]) + ":" + value + "}"
	}
	return insertJSONMember(content, rootStart, path[0], value)
}

// insertJSONMember 把成员插到对象第一个成员之前（保持有效的 JSON/JSONC）。
func insertJSONMember(content string, objectStart int, key string, encoded string) (string, error) {
	first := skipJSONCWhitespaceAndComments(content, objectStart+1)
	if first >= len(content) {
		return "", fmt.Errorf("JSON 对象未闭合")
	}
	quoted := strconv.Quote(key)
	if content[first] == '}' {
		return content[:objectStart+1] + "\n  " + quoted + ": " + encoded + "\n" + content[first:], nil
	}
	lineStart := strings.LastIndexByte(content[:first], '\n') + 1
	indent := ""
	if lineStart > 0 {
		prefix := content[lineStart:first]
		if strings.TrimSpace(prefix) == "" {
			indent = prefix
		}
	}
	if indent != "" {
		member := quoted + ": " + encoded + ",\n" + indent
		return content[:first] + member + content[first:], nil
	}
	member := quoted + ": " + encoded + ", "
	return content[:first] + member + content[first:], nil
}

// scanJSONString 读取一个 JSON 字符串字面量（含解码），返回结束位置。
func scanJSONString(content string, start int) (string, int, bool) {
	if start >= len(content) || content[start] != '"' {
		return "", 0, false
	}
	index := start + 1
	for index < len(content) {
		switch content[index] {
		case '\\':
			index += 2
			continue
		case '"':
			raw := content[start : index+1]
			var decoded string
			if json.Unmarshal([]byte(raw), &decoded) != nil {
				return "", 0, false
			}
			return decoded, index + 1, true
		}
		index++
	}
	return "", 0, false
}

// skipJSONValue 返回一个 JSON 值的结束位置；JSONC 注释与尾随逗号均可容忍。
func skipJSONValue(content string, start int) (int, bool) {
	index := skipJSONCWhitespaceAndComments(content, start)
	if index >= len(content) {
		return 0, false
	}
	switch content[index] {
	case '"':
		_, next, ok := scanJSONString(content, index)
		return next, ok
	case '{', '[':
		depth := 0
		for index < len(content) {
			switch content[index] {
			case '"':
				_, next, ok := scanJSONString(content, index)
				if !ok {
					return 0, false
				}
				index = next
				continue
			case '/':
				next := skipJSONCWhitespaceAndComments(content, index)
				if next == index {
					index++
					continue
				}
				index = next
				continue
			case '{', '[':
				depth++
			case '}', ']':
				depth--
				if depth == 0 {
					return index + 1, true
				}
			}
			index++
		}
		return 0, false
	default:
		for index < len(content) {
			switch content[index] {
			case ',', '}', ']', ' ', '\t', '\r', '\n':
				return index, true
			}
			index++
		}
		return index, true
	}
}

// removeTOMLValue 删除根级键所在的整行（含行尾），用于清除覆盖恢复默认。
func removeTOMLValue(content, path string) (string, error) {
	segments := strings.Split(path, ".")
	statement, found := findTOMLSetting(content, segments)
	if !found {
		return content, nil
	}
	// statement.End 由 expectLineEndOrComment 给出，已包含行尾（含 \r\n）；
	// 不能再向后找换行，否则会连同下一行一起删掉。
	return content[:statement.Start] + content[statement.End:], nil
}

// jsonMemberSpan 是 JSON 成员在原文中的区间；commaStart 是它前面的逗号（-1 表示首成员）。
type jsonMemberSpan struct {
	keyStart   int
	valueEnd   int
	commaStart int
}

// removeJSONValue 删除点号路径对应的成员，保留其余内容与注释。
func removeJSONValue(content, path string) (string, error) {
	segments := strings.Split(path, ".")
	span, found := findJSONMember(content, segments)
	if !found {
		return content, nil
	}
	if span.commaStart >= 0 {
		return content[:span.commaStart] + content[span.valueEnd:], nil
	}
	end := span.valueEnd
	if next := skipJSONCWhitespaceAndComments(content, end); next < len(content) && content[next] == ',' {
		end = next + 1
	}
	return content[:span.keyStart] + content[end:], nil
}

func findJSONMember(content string, path []string) (jsonMemberSpan, bool) {
	if len(path) == 0 {
		return jsonMemberSpan{}, false
	}
	start := skipJSONCWhitespaceAndComments(content, 0)
	if start >= len(content) || content[start] != '{' {
		return jsonMemberSpan{}, false
	}
	return findJSONMemberInObject(content, start, path)
}

func findJSONMemberInObject(content string, objectStart int, path []string) (jsonMemberSpan, bool) {
	index := objectStart + 1
	commaStart := -1
	for {
		index = skipJSONCWhitespaceAndComments(content, index)
		if index >= len(content) || content[index] == '}' {
			return jsonMemberSpan{}, false
		}
		if content[index] == ',' {
			commaStart = index
			index++
			continue
		}
		keyStart := index
		key, next, ok := scanJSONString(content, index)
		if !ok {
			return jsonMemberSpan{}, false
		}
		index = skipJSONCWhitespaceAndComments(content, next)
		if index >= len(content) || content[index] != ':' {
			return jsonMemberSpan{}, false
		}
		valueStart := skipJSONCWhitespaceAndComments(content, index+1)
		valueEnd, ok := skipJSONValue(content, valueStart)
		if !ok {
			return jsonMemberSpan{}, false
		}
		if key == path[0] {
			if len(path) == 1 {
				return jsonMemberSpan{keyStart: keyStart, valueEnd: valueEnd, commaStart: commaStart}, true
			}
			if valueStart < len(content) && content[valueStart] == '{' {
				return findJSONMemberInObject(content, valueStart, path[1:])
			}
			return jsonMemberSpan{}, false
		}
		index = valueEnd
	}
}
