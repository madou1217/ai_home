package providerconfigs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

// ConfigError 表示 Provider 配置工作台业务领域错误，HTTP 层据此映射状态码。
type ConfigError struct {
	Code       string            `json:"error"`
	Message    string            `json:"message"`
	Validation *ValidationResult `json:"validation,omitempty"`
}

func (e *ConfigError) Error() string { return e.Message }

// HTTPStatus 将错误码映射为与 Node 原契约一致的 HTTP 状态码。
func (e *ConfigError) HTTPStatus() int {
	switch e.Code {
	case "provider_config_unknown_file", "provider_config_not_found", "provider_config_history_entry_not_found":
		return 404
	case "provider_config_conflict":
		return 409
	case "provider_config_validation_failed":
		return 422
	case "provider_config_too_large":
		return 413
	case "provider_config_not_writable":
		return 403
	default:
		return 500
	}
}

// IsConfigError 断言并返回 *ConfigError。
func IsConfigError(err error) (*ConfigError, bool) {
	var cfgErr *ConfigError
	if errors.As(err, &cfgErr) {
		return cfgErr, true
	}
	return nil, false
}

// FileView 是单文件详情响应里的 `file` 子对象。
type FileView struct {
	PublicFile
	Writable          bool `json:"writable"`
	RequiresElevation bool `json:"requiresElevation"`
}

// ProviderSummary 是列表响应中的单个 Provider 分组。
type ProviderSummary struct {
	ID    string       `json:"id"`
	Label string       `json:"label"`
	CLI   *CLIInfo     `json:"cli"`
	Files []PublicFile `json:"files"`
}

// ListResponse 对应 GET /provider-configs 响应。
type ListResponse struct {
	OK        bool              `json:"ok"`
	Providers []ProviderSummary `json:"providers"`
	Total     int               `json:"total"`
}

// ReadResponse 对应 GET /provider-configs/:provider/:fileId 响应。
type ReadResponse struct {
	OK            bool                 `json:"ok"`
	Provider      string               `json:"provider"`
	File          FileView             `json:"file"`
	Content       string               `json:"content"`
	Revision      string               `json:"revision"`
	Size          int                  `json:"size"`
	CLI           CLIInfo              `json:"cli"`
	Schema        *AnnotatedSchema     `json:"schema"`
	SchemaVersion *SchemaVersionStatus `json:"schemaVersion"`
	HistoryCount  int                  `json:"historyCount"`
	HistoryLimit  int                  `json:"historyLimit"`
	DocsURL       string               `json:"docsUrl"`
	Description   string               `json:"description"`
}

// SaveOptions 定义保存配置的可选乐观锁与版本备注。
type SaveOptions struct {
	ExpectedRevision string
	Note             string
	Reason           string
}

// SaveResponse 对应 PUT /provider-configs/:provider/:fileId 及 restore 响应。
type SaveResponse struct {
	OK           bool             `json:"ok"`
	Provider     string           `json:"provider"`
	FileID       string           `json:"fileId"`
	Revision     string           `json:"revision"`
	Size         int              `json:"size"`
	SavedAt      int64            `json:"savedAt"`
	Changed      bool             `json:"changed"`
	HistoryEntry *HistorySummary  `json:"historyEntry"`
	Validation   ValidationResult `json:"validation"`
}

// ValidateResponse 对应 POST /provider-configs/:provider/:fileId/validate 响应。
type ValidateResponse struct {
	OK       bool              `json:"ok"`
	Provider string            `json:"provider"`
	FileID   string            `json:"fileId"`
	Format   string            `json:"format"`
	Valid    bool              `json:"valid"`
	Errors   []ValidationError `json:"errors"`
	Empty    bool              `json:"empty,omitempty"`
	Skipped  bool              `json:"skipped,omitempty"`
}

// HistoryListResponse 对应 GET .../history 响应。
type HistoryListResponse struct {
	OK       bool             `json:"ok"`
	Provider string           `json:"provider"`
	FileID   string           `json:"fileId"`
	Entries  []HistorySummary `json:"entries"`
	Limit    int              `json:"limit"`
}

// HistoryEntryResponse 对应 GET .../history/:entryId 响应。
type HistoryEntryResponse struct {
	OK       bool          `json:"ok"`
	Provider string        `json:"provider"`
	FileID   string        `json:"fileId"`
	Entry    *HistoryEntry `json:"entry"`
}

// ExportResponse 对应 GET .../export 响应。
type ExportResponse struct {
	OK             bool     `json:"ok"`
	Provider       string   `json:"provider"`
	FileID         string   `json:"fileId"`
	Mode           string   `json:"mode"`
	Filename       string   `json:"filename"`
	Content        string   `json:"content"`
	RedactedFields []string `json:"redactedFields"`
	Parsed         *bool    `json:"parsed,omitempty"`
	Sensitive      bool     `json:"sensitive"`
	Warning        string   `json:"warning"`
}

// Service 提供 Provider 配置文件列表、读取、校验、原子保存、版本历史及脱敏导出。
type Service struct {
	catalog     *providers.Catalog
	hostHomeDir string
	aiHomeDir   string
	env         map[string]string
	cliRunner   CLIRunner

	cliMu    sync.Mutex
	cliCache map[string]cachedVersion
}

// NewService 构造 Provider 配置服务实例。
func NewService(catalog *providers.Catalog, hostHomeDir, aiHomeDir string) *Service {
	if catalog == nil {
		if built, err := providers.NewCatalog(providers.BuiltinManifest()); err == nil {
			catalog = built
		}
	}
	return &Service{
		catalog:     catalog,
		hostHomeDir: strings.TrimSpace(hostHomeDir),
		aiHomeDir:   strings.TrimSpace(aiHomeDir),
		env:         envMapFromOS(),
		cliRunner:   newHostCLIRunner(catalog),
		cliCache:    make(map[string]cachedVersion),
	}
}

// WithCLIRunner 注入自定义 CLI 探测器（供单测使用）。
func (s *Service) WithCLIRunner(runner CLIRunner) *Service {
	if runner != nil {
		s.cliRunner = runner
	}
	return s
}

func envMapFromOS() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		idx := strings.IndexByte(entry, '=')
		if idx <= 0 {
			continue
		}
		env[entry[:idx]] = entry[idx+1:]
	}
	return env
}

func (s *Service) resolveHostHome() string {
	if s.hostHomeDir != "" {
		return s.hostHomeDir
	}
	if h, err := os.UserHomeDir(); err == nil {
		return strings.TrimSpace(h)
	}
	return strings.TrimSpace(s.env["HOME"])
}

func (s *Service) resolveCLIInfo(ctx context.Context, provider string) CLIInfo {
	hostHome := s.resolveHostHome()
	cacheKey := hostHome + "|" + provider
	s.cliMu.Lock()
	if cached, ok := s.cliCache[cacheKey]; ok && time.Since(cached.at) < cliVersionCacheTTL {
		s.cliMu.Unlock()
		return cached.info
	}
	s.cliMu.Unlock()

	bin := s.cliRunner.ResolveBinary(provider, hostHome, s.env)
	ver := ""
	if bin != "" {
		ver = s.cliRunner.Version(ctx, bin)
	}
	info := CLIInfo{
		Installed: bin != "",
		Version:   ver,
		Path:      displayPath(bin, hostHome),
	}
	s.cliMu.Lock()
	s.cliCache[cacheKey] = cachedVersion{at: time.Now(), info: info}
	s.cliMu.Unlock()
	return info
}

func (s *Service) resolveCLIEquivalents(ctx context.Context, provider string, fields []SchemaField) map[string]CLIEquivalent {
	if len(fields) == 0 {
		return nil
	}
	bin := s.cliRunner.ResolveBinary(provider, s.resolveHostHome(), s.env)
	if bin == "" {
		return nil
	}
	help := s.cliRunner.Help(ctx, bin)
	if strings.TrimSpace(help) == "" {
		return nil
	}
	cmd := strings.TrimSuffix(filepath.Base(bin), filepath.Ext(bin))
	return BuildFieldCLIEquivalents(provider, fields, help, cmd)
}

func (s *Service) resolveFile(provider, fileID string) (resolvedFile, error) {
	def, ok := getProviderDefinition(s.catalog, provider, fileID)
	if !ok {
		return resolvedFile{}, &ConfigError{
			Code:    "provider_config_unknown_file",
			Message: "未登记该 Provider 配置文件",
		}
	}
	return describeDefinition(s.catalog, def, s.resolveHostHome(), s.env), nil
}

// ListProviders 返回全部 Provider 及可管理的配置文件清单。
func (s *Service) ListProviders(ctx context.Context, includeCLIVersions bool) ListResponse {
	var ids []string
	labels := make(map[string]string)
	if s.catalog != nil {
		for _, def := range s.catalog.List() {
			ids = append(ids, def.ID)
			if def.Presentation.Label != "" {
				labels[def.ID] = def.Presentation.Label
			} else {
				labels[def.ID] = def.ID
			}
		}
	}
	hostHome := s.resolveHostHome()
	providersList := make([]ProviderSummary, 0, len(ids))
	total := 0
	for _, id := range ids {
		defs := listProviderDefinitions(s.catalog, id)
		if len(defs) == 0 {
			continue
		}
		files := make([]PublicFile, 0, len(defs))
		for _, def := range defs {
			files = append(files, describeDefinition(s.catalog, def, hostHome, s.env).Public)
		}
		var cli *CLIInfo
		if includeCLIVersions {
			info := s.resolveCLIInfo(ctx, id)
			cli = &info
		}
		providersList = append(providersList, ProviderSummary{
			ID:    id,
			Label: labels[id],
			CLI:   cli,
			Files: files,
		})
		total += len(files)
	}
	return ListResponse{
		OK:        true,
		Providers: providersList,
		Total:     total,
	}
}

// ReadFile 读取配置文件内容、revision、Schema 与历史计数。
func (s *Service) ReadFile(ctx context.Context, provider, fileID string) (*ReadResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	content, revision, size, _, err := readTargetContent(rf)
	if err != nil {
		return nil, err
	}
	cliInfo := s.resolveCLIInfo(ctx, rf.Definition.Provider)
	var schema *ConfigSchema
	if rf.Definition.SchemaID != "" {
		schema = GetConfigSchema(rf.Definition.SchemaID)
	}
	var equivalents map[string]CLIEquivalent
	if schema != nil {
		equivalents = s.resolveCLIEquivalents(ctx, rf.Definition.Provider, schema.Fields)
	}
	historyEntries := listHistoryEntries(s.aiHomeDir, rf.Definition.Provider, rf.Definition.ID)
	return &ReadResponse{
		OK:       true,
		Provider: rf.Definition.Provider,
		File: FileView{
			PublicFile:        rf.Public,
			Writable:          rf.Writable,
			RequiresElevation: !rf.Writable,
		},
		Content:       content,
		Revision:      revision,
		Size:          size,
		CLI:           cliInfo,
		Schema:        annotateSchema(schema, cliInfo.Version, equivalents),
		SchemaVersion: computeSchemaVersionStatus(schema, cliInfo),
		HistoryCount:  len(historyEntries),
		HistoryLimit:  MaxHistoryEntries,
		DocsURL:       rf.Definition.DocsURL,
		Description:   rf.Definition.Description,
	}, nil
}

// SaveFile 校验并原子保存配置，冲突时返回 409，变更前后自动留存历史快照。
func (s *Service) SaveFile(_ context.Context, provider, fileID, content string, opts SaveOptions) (*SaveResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	if len(content) > maxEditableBytes {
		return nil, &ConfigError{
			Code:    "provider_config_too_large",
			Message: "配置文件超过 2MB 编辑上限",
		}
	}
	validation := ValidateContent(content, rf.Public.Format)
	if !validation.Valid {
		return nil, &ConfigError{
			Code:       "provider_config_validation_failed",
			Message:    "配置语法不合法，未写入文件",
			Validation: &validation,
		}
	}
	if !rf.Writable {
		return nil, &ConfigError{
			Code:    "provider_config_not_writable",
			Message: "当前用户没有写入该配置文件的权限",
		}
	}

	curContent, curRevision, _, exists, err := readTargetContent(rf)
	if err != nil {
		return nil, err
	}
	expectedRev := strings.TrimSpace(opts.ExpectedRevision)
	if expectedRev != "" && expectedRev != curRevision {
		return nil, &ConfigError{
			Code:    "provider_config_conflict",
			Message: "配置文件在编辑期间已被其他进程修改，请重新读取后再保存",
		}
	}

	revision := hashSHA256(content)
	var schema *ConfigSchema
	if rf.Definition.SchemaID != "" {
		schema = GetConfigSchema(rf.Definition.SchemaID)
	}
	containsSecrets := hasSecretsInFile(rf.Public.Sensitive, schema)
	changed := !exists || curContent != content
	var historyEntry *HistorySummary

	if changed {
		if exists && curContent != "" && len(listHistoryEntries(s.aiHomeDir, rf.Definition.Provider, rf.Definition.ID)) == 0 {
			_, _ = appendHistoryEntry(s.aiHomeDir, rf.Definition.Provider, rf.Definition.ID, HistoryEntry{
				Revision:        curRevision,
				Content:         curContent,
				Reason:          "baseline",
				Note:            "首次通过 AIH 保存前的原始内容",
				ContainsSecrets: containsSecrets,
			})
		}
		if err := writeAtomicConfig(rf.AbsolutePath, content, rf.Public.Sensitive); err != nil {
			return nil, err
		}
		reason := "save"
		if opts.Reason == "restore" {
			reason = "restore"
		}
		historyEntry, _ = appendHistoryEntry(s.aiHomeDir, rf.Definition.Provider, rf.Definition.ID, HistoryEntry{
			Revision:        revision,
			Content:         content,
			Reason:          reason,
			Note:            opts.Note,
			ContainsSecrets: containsSecrets,
		})
	}

	return &SaveResponse{
		OK:           true,
		Provider:     provider,
		FileID:       rf.Definition.ID,
		Revision:     revision,
		Size:         len(content),
		SavedAt:      time.Now().UnixMilli(),
		Changed:      changed,
		HistoryEntry: historyEntry,
		Validation:   validation,
	}, nil
}

// ValidateFile 仅检验配置文本语法，不接触磁盘目标。
func (s *Service) ValidateFile(provider, fileID, content string) (*ValidateResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	res := ValidateContent(content, rf.Public.Format)
	return &ValidateResponse{
		OK:       true,
		Provider: provider,
		FileID:   rf.Definition.ID,
		Format:   rf.Public.Format,
		Valid:    res.Valid,
		Errors:   res.Errors,
		Empty:    res.Empty,
		Skipped:  res.Skipped,
	}, nil
}

// ListHistory 返回指定配置文件的本机版本历史摘要。
func (s *Service) ListHistory(provider, fileID string) (*HistoryListResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	entries := listHistoryEntries(s.aiHomeDir, provider, rf.Definition.ID)
	return &HistoryListResponse{
		OK:       true,
		Provider: provider,
		FileID:   rf.Definition.ID,
		Entries:  entries,
		Limit:    MaxHistoryEntries,
	}, nil
}

// ReadHistoryEntry 按条目 ID 读取历史版本的配置文本。
func (s *Service) ReadHistoryEntry(provider, fileID, entryID string) (*HistoryEntryResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	entry, ok := getHistoryEntry(s.aiHomeDir, provider, rf.Definition.ID, entryID)
	if !ok {
		return nil, &ConfigError{
			Code:    "provider_config_history_entry_not_found",
			Message: "版本记录不存在或已被清理",
		}
	}
	return &HistoryEntryResponse{
		OK:       true,
		Provider: provider,
		FileID:   rf.Definition.ID,
		Entry:    entry,
	}, nil
}

// RestoreHistoryEntry 将配置文件原子回滚到指定历史条目并记录一条 restore 历史。
func (s *Service) RestoreHistoryEntry(ctx context.Context, provider, fileID, entryID string) (*SaveResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	entry, ok := getHistoryEntry(s.aiHomeDir, provider, rf.Definition.ID, entryID)
	if !ok {
		return nil, &ConfigError{
			Code:    "provider_config_history_entry_not_found",
			Message: "版本记录不存在或已被清理",
		}
	}
	_, curRev, _, _, err := readTargetContent(rf)
	if err != nil {
		return nil, err
	}
	noteTime := time.UnixMilli(entry.SavedAt).UTC().Format("2006-01-02T15:04:05.000Z")
	return s.SaveFile(ctx, provider, fileID, entry.Content, SaveOptions{
		ExpectedRevision: curRev,
		Reason:           "restore",
		Note:             fmt.Sprintf("恢复 %s 的版本", noteTime),
	})
}

// ExportFile 导出配置（支持 raw 与 redacted 两种模式）。
func (s *Service) ExportFile(ctx context.Context, provider, fileID, mode string) (*ExportResponse, error) {
	rf, err := s.resolveFile(provider, fileID)
	if err != nil {
		return nil, err
	}
	detail, err := s.ReadFile(ctx, provider, fileID)
	if err != nil {
		return nil, err
	}
	exportMode := "redacted"
	if strings.EqualFold(strings.TrimSpace(mode), "raw") {
		exportMode = "raw"
	}
	ext := filepath.Ext(rf.Definition.Label)
	base := strings.TrimSuffix(rf.Definition.Label, ext)

	if exportMode == "raw" {
		warn := ""
		if rf.Public.Sensitive {
			warn = "原文件包含凭据，请只发送给可信对象。"
		}
		return &ExportResponse{
			OK:             true,
			Provider:       provider,
			FileID:         rf.Definition.ID,
			Mode:           "raw",
			Filename:       rf.Definition.Label,
			Content:        detail.Content,
			RedactedFields: []string{},
			Sensitive:      rf.Public.Sensitive,
			Warning:        warn,
		}, nil
	}

	var schema *ConfigSchema
	if rf.Definition.SchemaID != "" {
		schema = GetConfigSchema(rf.Definition.SchemaID)
	}
	redacted := RedactConfigContent(detail.Content, rf.Public.Format, schema, rf.Public.Sensitive)
	parsed := redacted.Parsed
	return &ExportResponse{
		OK:             true,
		Provider:       provider,
		FileID:         rf.Definition.ID,
		Mode:           "redacted",
		Filename:       fmt.Sprintf("%s.redacted%s", base, ext),
		Content:        redacted.Content,
		RedactedFields: redacted.Fields,
		Parsed:         &parsed,
		Sensitive:      rf.Public.Sensitive,
		Warning:        "",
	}, nil
}

func hashSHA256(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func isWritableTarget(targetPath string) bool {
	if targetPath == "" {
		return false
	}
	if _, err := os.Stat(targetPath); err == nil {
		return syscall.Access(targetPath, 2 /* W_OK */) == nil
	}
	dir := filepath.Dir(targetPath)
	for dir != "" {
		if _, err := os.Stat(dir); err == nil {
			return syscall.Access(dir, 2 /* W_OK */) == nil
		}
		parent := filepath.Dir(dir)
		if parent == "" || parent == dir {
			return false
		}
		dir = parent
	}
	return false
}

func readTargetContent(rf resolvedFile) (content, revision string, size int, exists bool, err error) {
	if !rf.Public.Exists {
		return "", "", 0, false, nil
	}
	info, statErr := os.Stat(rf.AbsolutePath)
	if statErr != nil {
		return "", "", 0, false, &ConfigError{Code: "provider_config_read_failed", Message: "读取配置失败"}
	}
	if info.Size() > maxEditableBytes {
		return "", "", 0, false, &ConfigError{Code: "provider_config_too_large", Message: "配置文件超过 2MB 编辑上限"}
	}
	raw, readErr := os.ReadFile(rf.AbsolutePath)
	if readErr != nil {
		return "", "", 0, false, &ConfigError{Code: "provider_config_read_failed", Message: "读取配置失败"}
	}
	text := string(raw)
	return text, hashSHA256(text), len(raw), true, nil
}

func writeAtomicConfig(targetPath, content string, sensitive bool) error {
	mode := os.FileMode(0o644)
	if sensitive {
		mode = 0o600
	}
	if info, err := os.Stat(targetPath); err == nil {
		mode = info.Mode().Perm()
	}
	dirMode := os.FileMode(0o755)
	if sensitive {
		dirMode = 0o700
	}
	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return &ConfigError{Code: "provider_config_save_failed", Message: "创建配置目录失败"}
	}
	var rnd [6]byte
	_, _ = rand.Read(rnd[:])
	tmp := fmt.Sprintf("%s.aih-provider-%d-%s.tmp", targetPath, os.Getpid(), hex.EncodeToString(rnd[:]))
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return &ConfigError{Code: "provider_config_save_failed", Message: "保存配置失败"}
	}
	_, writeErr := f.WriteString(content)
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		return &ConfigError{Code: "provider_config_save_failed", Message: "保存配置失败"}
	}
	_ = os.Chmod(tmp, mode)
	if err := os.Rename(tmp, targetPath); err != nil {
		_ = os.Remove(tmp)
		return &ConfigError{Code: "provider_config_save_failed", Message: "保存配置失败"}
	}
	_ = os.Chmod(targetPath, mode)
	return nil
}

func hasSecretsInFile(sensitive bool, schema *ConfigSchema) bool {
	if sensitive {
		return true
	}
	if schema == nil {
		return false
	}
	if schema.Sensitive {
		return true
	}
	for _, f := range schema.Fields {
		if f.Secret {
			return true
		}
	}
	return false
}
