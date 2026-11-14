package pluginhost

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	AccountSourceCapability      = "account.source"
	AccountLoginCapability       = "account.login"
	AccountRefreshCapability     = "account.refresh"
	AccountMaterializeCapability = "account.materialize"
	defaultListTimeout           = 5 * time.Second
	defaultAccountTimeout        = 15 * time.Second
	defaultMatchTimeout          = 3 * time.Second
)

// AccountWarning 记录账号插件枚举期间的单源告警。
type AccountWarning struct {
	Code           string `json:"code"`
	ContributionID string `json:"contributionId,omitempty"`
	Detail         string `json:"detail,omitempty"`
}

// AccountSourcesResult 表示账号插件来源列表返回值。
type AccountSourcesResult struct {
	Sources    []AccountSource  `json:"sources"`
	Warnings   []AccountWarning `json:"warnings"`
	Generation int64            `json:"generation"`
}

// AccountListOptions 配置来源枚举选项。
type AccountListOptions struct {
	Host               any
	TimeoutMs          int
	AllowSourceFailure bool
}

// ProjectionRegisterRequest 描述将 runtimeDir 中的认证投影登记到宿主账号库所需的参数。
type ProjectionRegisterRequest struct {
	Provider        string
	RuntimeDir      string
	AccountRef      string
	RespectDeletion bool
}

// ProjectionRegisterResult 描述认证投影入库结果（或被墓碑拦截的原因）。
type ProjectionRegisterResult struct {
	Registered   bool   `json:"registered"`
	Reason       string `json:"reason,omitempty"`
	Provider     string `json:"provider,omitempty"`
	AccountRef   string `json:"accountRef,omitempty"`
	CLIAccountID string `json:"cliAccountId,omitempty"`
}

// AccountProjectionRegistrar 将认证投影目录解码并登记到账号存储的端口。
type AccountProjectionRegistrar interface {
	RegisterProjection(ctx context.Context, req ProjectionRegisterRequest) (ProjectionRegisterResult, error)
}

// AccountImportRequest 是直接导入来源的入参。
type AccountImportRequest struct {
	Provider   string `json:"provider"`
	SourceID   string `json:"sourceId"`
	RuntimeDir string `json:"runtimeDir,omitempty"`
	AccountRef string `json:"accountRef,omitempty"`
	TimeoutMs  int    `json:"timeoutMs,omitempty"`
}

// AccountImportResult 与 Node account.importSource 返回体字段逐一对齐。
type AccountImportResult struct {
	OK           bool             `json:"ok"`
	Code         string           `json:"code,omitempty"`
	Detail       string           `json:"detail,omitempty"`
	Source       *AccountSource   `json:"source,omitempty"`
	Warnings     []AccountWarning `json:"warnings,omitempty"`
	AccountRef   string           `json:"accountRef,omitempty"`
	CLIAccountID string           `json:"cliAccountId,omitempty"`
	SourceID     string           `json:"sourceId,omitempty"`
	RuntimeDir   string           `json:"runtimeDir,omitempty"`
}

// AccountRefreshRequest 是账号刷新插件调用入参。
type AccountRefreshRequest struct {
	Provider             string `json:"provider"`
	AccountRef           string `json:"accountRef"`
	Credential           any    `json:"credential,omitempty"`
	ConsumedRefreshToken string `json:"consumedRefreshToken,omitempty"`
	RuntimeDir           string `json:"runtimeDir,omitempty"`
	CAS                  *bool  `json:"cas,omitempty"`
	TimeoutMs            int    `json:"timeoutMs,omitempty"`
}

// AccountRefreshResult 与 Node account.refresh 返回体对齐。
type AccountRefreshResult struct {
	Handled        bool                      `json:"handled"`
	ContributionID string                    `json:"contributionId,omitempty"`
	Reason         string                    `json:"reason,omitempty"`
	Detail         string                    `json:"detail,omitempty"`
	CAS            *bool                     `json:"cas,omitempty"`
	Files          []string                  `json:"files,omitempty"`
	Rotated        bool                      `json:"rotated,omitempty"`
	ExpiresAt      int64                     `json:"expiresAt,omitempty"`
	Registration   *ProjectionRegisterResult `json:"registration,omitempty"`
}

// AccountMaterializeRequest 是凭据物化插件调用入参。
type AccountMaterializeRequest struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef,omitempty"`
	Credential any    `json:"credential,omitempty"`
	RuntimeDir string `json:"runtimeDir,omitempty"`
	TimeoutMs  int    `json:"timeoutMs,omitempty"`
}

// AccountMaterializeResult 与 Node account.materialize 返回体对齐。
type AccountMaterializeResult struct {
	Handled        bool     `json:"handled"`
	ContributionID string   `json:"contributionId,omitempty"`
	Reason         string   `json:"reason,omitempty"`
	Detail         string   `json:"detail,omitempty"`
	Files          []string `json:"files,omitempty"`
	Removed        []string `json:"removed,omitempty"`
}

// ListAccountSources 枚举指定 provider 当前激活代次可用的认证来源。
func (s *Service) ListAccountSources(
	ctx context.Context,
	provider string,
	opts AccountListOptions,
) (AccountSourcesResult, error) {
	normalizedProvider, err := normalizeAccountProvider(provider)
	if err != nil {
		return AccountSourcesResult{}, err
	}
	if s == nil || s.runtime == nil {
		return AccountSourcesResult{Sources: []AccountSource{}, Warnings: []AccountWarning{}}, nil
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return AccountSourcesResult{Sources: []AccountSource{}, Warnings: []AccountWarning{}}, nil
	}
	defer lease.Release()

	timeout := defaultListTimeout
	if opts.TimeoutMs > 0 {
		timeout = time.Duration(opts.TimeoutMs) * time.Millisecond
		if timeout < 500*time.Millisecond {
			timeout = 500 * time.Millisecond
		}
	}

	sources := make([]AccountSource, 0)
	warnings := make([]AccountWarning, 0)
	seenIDs := make(map[string]struct{})
	chain := lease.Snapshot.Projection.ByCapability(AccountSourceCapability)
	for _, item := range chain {
		raw, invokeErr := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": AccountSchemaVersion,
			"kind":          "list",
			"provider":      normalizedProvider,
			"host":          opts.Host,
		}, timeout)
		if invokeErr != nil {
			warnings = append(warnings, AccountWarning{
				Code:           firstNonEmpty(errorCode(invokeErr), "account_source_failed"),
				ContributionID: item.ID,
				Detail:         strings.TrimSpace(invokeErr.Error()),
			})
			if item.FailurePolicy == "deny" && !opts.AllowSourceFailure {
				warnings = append(warnings, AccountWarning{
					Code:           "account_source_chain_degraded",
					ContributionID: item.ID,
				})
			}
			continue
		}
		normalized, normErr := normalizeSourceListResult(raw, accountSourceMeta{
			InstanceID:     item.InstanceID,
			ContributionID: item.ID,
			Provider:       normalizedProvider,
		})
		if normErr != nil {
			warnings = append(warnings, AccountWarning{
				Code:           firstNonEmpty(errorCode(normErr), "account_source_failed"),
				ContributionID: item.ID,
				Detail:         strings.TrimSpace(normErr.Error()),
			})
			if item.FailurePolicy == "deny" && !opts.AllowSourceFailure {
				warnings = append(warnings, AccountWarning{
					Code:           "account_source_chain_degraded",
					ContributionID: item.ID,
				})
			}
			continue
		}
		for _, src := range normalized {
			if _, exists := seenIDs[src.ID]; exists {
				warnings = append(warnings, AccountWarning{
					Code:           "account_source_duplicate",
					ContributionID: item.ID,
					Detail:         src.ID,
				})
				continue
			}
			seenIDs[src.ID] = struct{}{}
			loginItem, loginErr := findLoginContribution(lease.Snapshot.Projection, src)
			if loginErr != nil {
				warnings = append(warnings, AccountWarning{
					Code:           firstNonEmpty(errorCode(loginErr), "account_login_contribution_missing"),
					ContributionID: item.ID,
					Detail:         src.ID,
				})
			}
			src.LoginAvailable = loginItem != nil
			sources = append(sources, src)
		}
	}
	return AccountSourcesResult{
		Sources:    sources,
		Warnings:   warnings,
		Generation: lease.Generation,
	}, nil
}

// ImportAccountSource 从声明 directImport 的插件来源直接导入投影并登记到宿主账号库。
func (s *Service) ImportAccountSource(
	ctx context.Context,
	req AccountImportRequest,
	registrar AccountProjectionRegistrar,
) (AccountImportResult, error) {
	provider, err := normalizeAccountProvider(req.Provider)
	if err != nil {
		return AccountImportResult{}, err
	}
	sourceID := strings.TrimSpace(req.SourceID)
	if sourceID == "" {
		return AccountImportResult{}, pluginerr.New("account_source_id_required", "sourceId 不能为空")
	}
	if s == nil || s.runtime == nil {
		return AccountImportResult{OK: false, Code: "plugin_runtime_inactive"}, nil
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return AccountImportResult{OK: false, Code: "plugin_runtime_inactive"}, nil
	}
	defer lease.Release()

	listed, err := s.ListAccountSources(ctx, provider, AccountListOptions{})
	if err != nil {
		return AccountImportResult{
			OK:     false,
			Code:   firstNonEmpty(errorCode(err), "account_plugin_import_failed"),
			Detail: strings.TrimSpace(err.Error()),
		}, nil
	}
	var target *AccountSource
	for i := range listed.Sources {
		if listed.Sources[i].ID == sourceID {
			target = &listed.Sources[i]
			break
		}
	}
	if target == nil {
		return AccountImportResult{OK: false, Code: "auth_source_unknown", Warnings: listed.Warnings}, nil
	}
	if !target.Available {
		return AccountImportResult{OK: false, Code: "auth_source_unavailable", Source: target}, nil
	}
	if !target.DirectImport {
		return AccountImportResult{OK: false, Code: "auth_source_requires_login_job", Source: target}, nil
	}
	chain := lease.Snapshot.Projection.ByCapability(AccountSourceCapability)
	var contribFound bool
	for _, item := range chain {
		if item.ID == target.PluginContributionID {
			contribFound = true
			break
		}
	}
	if !contribFound {
		return AccountImportResult{OK: false, Code: "auth_source_impl_missing", Source: target}, nil
	}

	runtimeDir, dirErr := s.resolveAccountRuntimeDir(provider, req.RuntimeDir)
	if dirErr != nil {
		return AccountImportResult{
			OK:     false,
			Code:   firstNonEmpty(errorCode(dirErr), "invalid_login_runtime"),
			Detail: strings.TrimSpace(dirErr.Error()),
		}, nil
	}
	if mkErr := os.MkdirAll(runtimeDir, 0o700); mkErr != nil {
		return AccountImportResult{
			OK:     false,
			Code:   "account_plugin_import_failed",
			Detail: mkErr.Error(),
		}, nil
	}

	timeout := accountTimeout(req.TimeoutMs)
	raw, invokeErr := s.runtime.Invoke(ctx, lease.Generation, target.PluginContributionID, map[string]any{
		"schemaVersion": AccountSchemaVersion,
		"kind":          "import",
		"provider":      provider,
		"sourceId":      sourceID,
	}, timeout)
	if invokeErr != nil {
		return AccountImportResult{
			OK:     false,
			Code:   firstNonEmpty(errorCode(invokeErr), "account_plugin_import_failed"),
			Detail: strings.TrimSpace(invokeErr.Error()),
		}, nil
	}

	files, removed, matErr := s.resolveSourceFiles(ctx, lease, target, raw, runtimeDir, timeout)
	if matErr != nil {
		return AccountImportResult{
			OK:     false,
			Code:   firstNonEmpty(errorCode(matErr), "account_plugin_import_failed"),
			Detail: strings.TrimSpace(matErr.Error()),
		}, nil
	}
	if len(files) == 0 {
		return AccountImportResult{OK: false, Code: "account_plugin_files_missing", Source: target}, nil
	}
	if _, writeErr := WriteProjectionFiles(runtimeDir, files, removed); writeErr != nil {
		return AccountImportResult{
			OK:     false,
			Code:   firstNonEmpty(errorCode(writeErr), "account_plugin_import_failed"),
			Detail: strings.TrimSpace(writeErr.Error()),
		}, nil
	}

	reg, regErr := registerProjectionOrError(ctx, registrar, ProjectionRegisterRequest{
		Provider:        provider,
		RuntimeDir:      runtimeDir,
		AccountRef:      strings.TrimSpace(req.AccountRef),
		RespectDeletion: true,
	})
	if regErr != nil {
		return AccountImportResult{
			OK:     false,
			Code:   firstNonEmpty(errorCode(regErr), "account_plugin_registration_failed"),
			Detail: strings.TrimSpace(regErr.Error()),
		}, nil
	}

	s.Audit("account_import", map[string]any{
		"provider":   provider,
		"sourceId":   sourceID,
		"accountRef": reg.AccountRef,
		"files":      len(files),
	})
	return AccountImportResult{
		OK:           true,
		AccountRef:   reg.AccountRef,
		CLIAccountID: reg.CLIAccountID,
		SourceID:     sourceID,
		RuntimeDir:   runtimeDir,
	}, nil
}

// RefreshAccount 调用 account.refresh 插件刷新已有凭据，并在提供 runtimeDir 时写回投影与注册入库。
func (s *Service) RefreshAccount(
	ctx context.Context,
	req AccountRefreshRequest,
	registrar AccountProjectionRegistrar,
) (AccountRefreshResult, error) {
	provider, err := normalizeAccountProvider(req.Provider)
	if err != nil {
		return AccountRefreshResult{}, err
	}
	accountRef := strings.TrimSpace(req.AccountRef)
	if accountRef == "" {
		return AccountRefreshResult{}, pluginerr.New("account_ref_required", "accountRef 不能为空")
	}
	if s == nil || s.runtime == nil {
		return AccountRefreshResult{Handled: false, Reason: "plugin_runtime_inactive"}, nil
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return AccountRefreshResult{Handled: false, Reason: "plugin_runtime_inactive"}, nil
	}
	defer lease.Release()

	chain := lease.Snapshot.Projection.ByCapability(AccountRefreshCapability)
	timeout := accountTimeout(req.TimeoutMs)
	for _, item := range chain {
		matchRaw, matchErr := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": AccountSchemaVersion,
			"kind":          "match",
			"provider":      provider,
		}, defaultMatchTimeout)
		if matchErr != nil {
			return AccountRefreshResult{
				Handled:        false,
				ContributionID: item.ID,
				Reason:         firstNonEmpty(errorCode(matchErr), "account_refresh_failed"),
				Detail:         strings.TrimSpace(matchErr.Error()),
			}, nil
		}
		if !matchHandles(matchRaw) {
			continue
		}
		runtimeDir := ""
		if strings.TrimSpace(req.RuntimeDir) != "" {
			checkedDir, dirErr := s.assertHostRuntimeDir(req.RuntimeDir)
			if dirErr != nil {
				return AccountRefreshResult{
					Handled:        false,
					ContributionID: item.ID,
					Reason:         firstNonEmpty(errorCode(dirErr), "account_refresh_failed"),
					Detail:         strings.TrimSpace(dirErr.Error()),
				}, nil
			}
			runtimeDir = checkedDir
		}
		digestBefore := ""
		if runtimeDir != "" {
			digestBefore = RuntimeDigest(runtimeDir)
		}
		consumed := strings.TrimSpace(req.ConsumedRefreshToken)
		if consumed == "" {
			consumed = extractRefreshToken(req.Credential)
		}
		refreshRaw, invokeErr := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion":        AccountSchemaVersion,
			"kind":                 "refresh",
			"provider":             provider,
			"accountRef":           accountRef,
			"credential":           req.Credential,
			"consumedRefreshToken": consumed,
			"runtimeDir":           runtimeDir,
		}, timeout)
		if invokeErr != nil {
			return AccountRefreshResult{
				Handled:        false,
				ContributionID: item.ID,
				Reason:         firstNonEmpty(errorCode(invokeErr), "account_refresh_failed"),
				Detail:         strings.TrimSpace(invokeErr.Error()),
			}, nil
		}
		result, normErr := normalizeRefreshResult(refreshRaw)
		if normErr != nil {
			return AccountRefreshResult{
				Handled:        false,
				ContributionID: item.ID,
				Reason:         firstNonEmpty(errorCode(normErr), "account_refresh_failed"),
				Detail:         strings.TrimSpace(normErr.Error()),
			}, nil
		}
		if result == nil || !result.Handled {
			return AccountRefreshResult{Handled: false, ContributionID: item.ID, Reason: "not_handled"}, nil
		}

		files := result.Files
		var removed []string
		if len(files) == 0 && len(result.Credential) > 0 {
			var matErr error
			files, removed, matErr = s.materializeCredential(ctx, lease, item.InstanceID, provider, accountRef, result.Credential, runtimeDir, timeout)
			if matErr != nil {
				return AccountRefreshResult{
					Handled:        false,
					ContributionID: item.ID,
					Reason:         firstNonEmpty(errorCode(matErr), "account_refresh_failed"),
					Detail:         strings.TrimSpace(matErr.Error()),
				}, nil
			}
		}

		var registration *ProjectionRegisterResult
		if runtimeDir != "" && len(files) > 0 {
			casEnabled := req.CAS == nil || *req.CAS
			if casEnabled && digestBefore != "" && RuntimeDigest(runtimeDir) != digestBefore {
				casFalse := false
				return AccountRefreshResult{
					Handled:        false,
					ContributionID: item.ID,
					Reason:         "account_refresh_conflict",
					CAS:            &casFalse,
				}, nil
			}
			if _, writeErr := WriteProjectionFiles(runtimeDir, files, removed); writeErr != nil {
				return AccountRefreshResult{
					Handled:        false,
					ContributionID: item.ID,
					Reason:         firstNonEmpty(errorCode(writeErr), "account_refresh_failed"),
					Detail:         strings.TrimSpace(writeErr.Error()),
				}, nil
			}
			reg, regErr := registerProjectionOrError(ctx, registrar, ProjectionRegisterRequest{
				Provider:   provider,
				RuntimeDir: runtimeDir,
				AccountRef: accountRef,
			})
			if regErr != nil {
				return AccountRefreshResult{
					Handled:        false,
					ContributionID: item.ID,
					Reason:         firstNonEmpty(errorCode(regErr), "account_refresh_failed"),
					Detail:         strings.TrimSpace(regErr.Error()),
				}, nil
			}
			registration = &reg
		}

		s.Audit("account_refresh", map[string]any{
			"provider":       provider,
			"accountRef":     accountRef,
			"contributionId": item.ID,
			"files":          len(files),
			"rotated":        result.Rotated,
		})
		return AccountRefreshResult{
			Handled:        true,
			ContributionID: item.ID,
			Files:          projectionFilePaths(files),
			Rotated:        result.Rotated,
			ExpiresAt:      result.ExpiresAt,
			Registration:   registration,
		}, nil
	}
	return AccountRefreshResult{Handled: false, Reason: "no_matching_plugin"}, nil
}

// MaterializeAccount 调用 account.materialize 插件将账号凭据物化到受控的 runtimeDir 中。
func (s *Service) MaterializeAccount(ctx context.Context, req AccountMaterializeRequest) (AccountMaterializeResult, error) {
	provider, err := normalizeAccountProvider(req.Provider)
	if err != nil {
		return AccountMaterializeResult{}, err
	}
	runtimeDir := ""
	if strings.TrimSpace(req.RuntimeDir) != "" {
		runtimeDir, err = s.assertHostRuntimeDir(req.RuntimeDir)
		if err != nil {
			return AccountMaterializeResult{}, err
		}
	}
	if s == nil || s.runtime == nil {
		return AccountMaterializeResult{Handled: false, Reason: "plugin_runtime_inactive"}, nil
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return AccountMaterializeResult{Handled: false, Reason: "plugin_runtime_inactive"}, nil
	}
	defer lease.Release()

	chain := lease.Snapshot.Projection.ByCapability(AccountMaterializeCapability)
	timeout := accountTimeout(req.TimeoutMs)
	accountRef := strings.TrimSpace(req.AccountRef)
	for _, item := range chain {
		matchRaw, matchErr := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": AccountSchemaVersion,
			"kind":          "match",
			"provider":      provider,
		}, defaultMatchTimeout)
		if matchErr != nil {
			return AccountMaterializeResult{
				Handled:        false,
				ContributionID: item.ID,
				Reason:         firstNonEmpty(errorCode(matchErr), "account_materialize_failed"),
				Detail:         strings.TrimSpace(matchErr.Error()),
			}, nil
		}
		if !matchHandles(matchRaw) {
			continue
		}
		matRaw, invokeErr := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": AccountSchemaVersion,
			"kind":          "materialize",
			"provider":      provider,
			"accountRef":    accountRef,
			"credential":    req.Credential,
			"runtimeDir":    runtimeDir,
		}, timeout)
		if invokeErr != nil {
			return AccountMaterializeResult{
				Handled:        false,
				ContributionID: item.ID,
				Reason:         firstNonEmpty(errorCode(invokeErr), "account_materialize_failed"),
				Detail:         strings.TrimSpace(invokeErr.Error()),
			}, nil
		}
		result, normErr := normalizeMaterializeResult(matRaw)
		if normErr != nil {
			return AccountMaterializeResult{
				Handled:        false,
				ContributionID: item.ID,
				Reason:         firstNonEmpty(errorCode(normErr), "account_materialize_failed"),
				Detail:         strings.TrimSpace(normErr.Error()),
			}, nil
		}
		if !result.Handled {
			return AccountMaterializeResult{Handled: false, ContributionID: item.ID}, nil
		}
		if _, writeErr := WriteProjectionFiles(runtimeDir, result.Files, result.Removed); writeErr != nil {
			return AccountMaterializeResult{
				Handled:        false,
				ContributionID: item.ID,
				Reason:         firstNonEmpty(errorCode(writeErr), "account_materialize_failed"),
				Detail:         strings.TrimSpace(writeErr.Error()),
			}, nil
		}
		s.Audit("account_materialize", map[string]any{
			"provider":       provider,
			"accountRef":     accountRef,
			"contributionId": item.ID,
			"files":          len(result.Files),
			"removed":        len(result.Removed),
		})
		return AccountMaterializeResult{
			Handled:        true,
			ContributionID: item.ID,
			Files:          projectionFilePaths(result.Files),
			Removed:        result.Removed,
		}, nil
	}
	return AccountMaterializeResult{Handled: false, Reason: "no_matching_plugin"}, nil
}

func findLoginContribution(projection appplugins.Projection, src AccountSource) (*appplugins.Contribution, error) {
	chain := projection.ByCapability(AccountLoginCapability)
	if len(chain) == 0 {
		return nil, nil
	}
	requested := strings.TrimSpace(src.LoginContribution)
	if requested != "" {
		for i := range chain {
			if chain[i].ID == requested {
				return &chain[i], nil
			}
		}
		return nil, pluginerr.New("account_login_contribution_missing", "登录贡献项不存在："+requested)
	}
	for i := range chain {
		if chain[i].InstanceID == src.PluginInstanceID {
			return &chain[i], nil
		}
	}
	return nil, nil
}

func (s *Service) resolveAccountRuntimeDir(provider, requestedDir string) (string, error) {
	if strings.TrimSpace(requestedDir) != "" {
		return s.assertHostRuntimeDir(requestedDir)
	}
	root := strings.TrimSpace(s.AIHomeDir())
	if root == "" {
		return "", pluginerr.New("invalid_login_runtime", "缺少 aiHomeDir")
	}
	var buf [6]byte
	_, _ = rand.Read(buf[:])
	sessionID := "plugin-" + hex.EncodeToString(buf[:])
	return filepath.Join(root, "run", "login", provider, sessionID), nil
}

func (s *Service) assertHostRuntimeDir(runtimeDir string) (string, error) {
	trimmed := strings.TrimSpace(runtimeDir)
	if trimmed == "" {
		return "", pluginerr.New("account_plugin_runtime_dir_missing", "缺少 runtimeDir")
	}
	root := strings.TrimSpace(s.AIHomeDir())
	if root == "" {
		return filepath.Abs(trimmed)
	}
	homeAbs, err := filepath.Abs(root)
	if err != nil {
		return "", pluginerr.New("account_plugin_runtime_dir_outside_home", "无法解析 AIH_HOME_DIR")
	}
	targetAbs, err := filepath.Abs(trimmed)
	if err != nil {
		return "", pluginerr.New("account_plugin_runtime_dir_outside_home", "runtimeDir 路径无效")
	}
	rel, relErr := filepath.Rel(homeAbs, targetAbs)
	if relErr != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", pluginerr.New("account_plugin_runtime_dir_outside_home", "runtimeDir 必须在 AIH_HOME_DIR 内")
	}
	return targetAbs, nil
}

func (s *Service) resolveSourceFiles(
	ctx context.Context,
	lease *Lease,
	source *AccountSource,
	raw json.RawMessage,
	runtimeDir string,
	timeout time.Duration,
) ([]ProjectionFile, []string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		files, err := normalizeProjectionFiles(raw)
		return files, nil, err
	}
	var obj struct {
		Files      json.RawMessage `json:"files"`
		Credential json.RawMessage `json:"credential"`
		Removed    []string        `json:"removed"`
	}
	if strings.HasPrefix(trimmed, "{") {
		if err := json.Unmarshal([]byte(trimmed), &obj); err != nil {
			return nil, nil, pluginerr.New("account_plugin_import_failed", "导入返回值 JSON 解析失败")
		}
	}
	if filesTrim := strings.TrimSpace(string(obj.Files)); filesTrim != "" && filesTrim != "null" && filesTrim != "[]" {
		files, err := normalizeProjectionFiles(obj.Files)
		return files, obj.Removed, err
	}
	if credObj := normalizeObjectJSON(obj.Credential); len(credObj) > 0 {
		return s.materializeCredential(ctx, lease, source.PluginInstanceID, source.Provider, "", credObj, runtimeDir, timeout)
	}
	if srcCred := normalizeObjectJSON(source.Credential); len(srcCred) > 0 {
		var srcCredObj struct {
			Files json.RawMessage `json:"files"`
		}
		if json.Unmarshal(srcCred, &srcCredObj) == nil {
			if filesTrim := strings.TrimSpace(string(srcCredObj.Files)); filesTrim != "" && filesTrim != "null" && filesTrim != "[]" {
				files, err := normalizeProjectionFiles(srcCredObj.Files)
				return files, nil, err
			}
		}
		return s.materializeCredential(ctx, lease, source.PluginInstanceID, source.Provider, "", srcCred, runtimeDir, timeout)
	}
	return nil, nil, nil
}

func (s *Service) materializeCredential(
	ctx context.Context,
	lease *Lease,
	instanceID string,
	provider string,
	accountRef string,
	credential json.RawMessage,
	runtimeDir string,
	timeout time.Duration,
) ([]ProjectionFile, []string, error) {
	var credObj struct {
		Files json.RawMessage `json:"files"`
	}
	if json.Unmarshal(credential, &credObj) == nil {
		if filesTrim := strings.TrimSpace(string(credObj.Files)); filesTrim != "" && filesTrim != "null" {
			files, err := normalizeProjectionFiles(credObj.Files)
			return files, nil, err
		}
	}
	chain := lease.Snapshot.Projection.ByCapability(AccountMaterializeCapability)
	for _, item := range chain {
		if instanceID != "" && item.InstanceID != instanceID {
			continue
		}
		matchRaw, err := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": AccountSchemaVersion,
			"kind":          "match",
			"provider":      provider,
		}, defaultMatchTimeout)
		if err != nil {
			return nil, nil, err
		}
		if !matchHandles(matchRaw) {
			continue
		}
		matRaw, err := s.runtime.Invoke(ctx, lease.Generation, item.ID, map[string]any{
			"schemaVersion": AccountSchemaVersion,
			"kind":          "materialize",
			"provider":      provider,
			"accountRef":    accountRef,
			"credential":    credential,
			"runtimeDir":    runtimeDir,
		}, timeout)
		if err != nil {
			return nil, nil, err
		}
		res, normErr := normalizeMaterializeResult(matRaw)
		if normErr != nil {
			return nil, nil, normErr
		}
		if res.Handled && len(res.Files) > 0 {
			return res.Files, res.Removed, nil
		}
	}
	return nil, nil, nil
}

func registerProjectionOrError(
	ctx context.Context,
	registrar AccountProjectionRegistrar,
	req ProjectionRegisterRequest,
) (ProjectionRegisterResult, error) {
	if registrar == nil {
		return ProjectionRegisterResult{}, pluginerr.New("account_plugin_registration_failed", "账号注册器未装配")
	}
	reg, err := registrar.RegisterProjection(ctx, req)
	if err != nil {
		return ProjectionRegisterResult{}, err
	}
	if !reg.Registered {
		reason := strings.TrimSpace(reg.Reason)
		if reason == "" {
			reason = "unknown"
		}
		if reason == "account_deleted_by_user" {
			return ProjectionRegisterResult{}, pluginerr.New("account_deleted_by_user", "该账号已被用户删除，自动导入不会复活它；如需重新使用请显式登录")
		}
		return ProjectionRegisterResult{}, pluginerr.New("account_plugin_registration_failed", fmt.Sprintf("账号注册失败：%s", reason))
	}
	return reg, nil
}

func accountTimeout(timeoutMs int) time.Duration {
	if timeoutMs > 0 {
		return time.Duration(timeoutMs) * time.Millisecond
	}
	return defaultAccountTimeout
}

func matchHandles(raw json.RawMessage) bool {
	var obj struct {
		Handles bool `json:"handles"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return false
	}
	return obj.Handles
}

func extractRefreshToken(credential any) string {
	if credential == nil {
		return ""
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		return ""
	}
	var obj struct {
		RefreshToken string `json:"refreshToken"`
	}
	if json.Unmarshal(encoded, &obj) != nil {
		return ""
	}
	return strings.TrimSpace(obj.RefreshToken)
}

func projectionFilePaths(files []ProjectionFile) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Path)
	}
	return out
}
