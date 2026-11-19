package pluginhost

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// 账号插件交互式登录（account.login）的宿主侧状态机。
//
// 契约与 Node lib/plugins/account/service.js 对齐：start / poll / submit / cancel
// 四个动词，状态只允许 waiting_user / success / failed（宿主额外落 cancelled /
// expired 两个终态）。插件只返回公开状态与投影文件，凭据不进入任务持久化文件。

const (
	accountLoginDefaultTimeout = 15 * time.Second
	accountLoginJobTTL         = 15 * time.Minute
	accountLoginMaxJobs        = 100
	accountLoginJobFile        = "account-login-jobs.json"
	accountLoginSubmitMaxBytes = 128 * 1024
)

var accountLoginStatuses = map[string]bool{
	"waiting_user": true,
	"success":      true,
	"failed":       true,
}

// AccountLoginJob 是宿主公开给浏览器的任务视图（键与 Node publicJob 一致）。
type AccountLoginJob struct {
	JobID                   string `json:"jobId"`
	Provider                string `json:"provider"`
	SourceID                string `json:"sourceId"`
	AuthMode                string `json:"authMode"`
	Status                  string `json:"status"`
	Message                 string `json:"message"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	UserCode                string `json:"userCode"`
	AuthorizationURL        string `json:"authorizationUrl"`
	RedirectURI             string `json:"redirectUri"`
	IntervalMs              int64  `json:"intervalMs"`
	CanSubmit               bool   `json:"canSubmit"`
	SubmitLabel             string `json:"submitLabel"`
	SubmitPlaceholder       string `json:"submitPlaceholder"`
	CreatedAt               int64  `json:"createdAt"`
	UpdatedAt               int64  `json:"updatedAt"`
	ExpiresAt               int64  `json:"expiresAt"`
	AccountRef              string `json:"accountRef"`
	CLIAccountID            string `json:"cliAccountId"`
	Error                   string `json:"error"`

	// 以下字段只在宿主内部与持久化文件里存在，不进入 HTTP 响应。
	ContributionID string `json:"contributionId,omitempty"`
	InstanceID     string `json:"instanceId,omitempty"`
	PluginJobID    string `json:"pluginJobId,omitempty"`
	RuntimeDir     string `json:"runtimeDir,omitempty"`
}

// AccountLoginStartRequest 是 start 的入参。
type AccountLoginStartRequest struct {
	Provider   string
	SourceID   string
	RuntimeDir string
	TimeoutMs  int
}

// Public 返回不含宿主内部定位字段的浏览器视图。
func (job AccountLoginJob) Public() AccountLoginJob {
	job.ContributionID = ""
	job.InstanceID = ""
	job.PluginJobID = ""
	job.RuntimeDir = ""
	return job
}

// accountLoginPluginResult 是插件 account.login 返回值的规范化视图。
type accountLoginPluginResult struct {
	Status                  string
	JobID                   string
	Message                 string
	VerificationURI         string
	VerificationURIComplete string
	UserCode                string
	AuthorizationURL        string
	RedirectURI             string
	IntervalMs              int64
	CanSubmit               bool
	SubmitLabel             string
	SubmitPlaceholder       string
	ExpiresAt               int64
	Files                   json.RawMessage
	Credential              json.RawMessage
	Removed                 []string
}

// accountLoginStore 是登录任务的并发安全持久化容器。
type accountLoginStore struct {
	mu   sync.Mutex
	path string
	jobs map[string]*AccountLoginJob
}

var (
	accountLoginStoresMu sync.Mutex
	accountLoginStores   = map[string]*accountLoginStore{}
)

func (s *Service) accountLoginStore() *accountLoginStore {
	root := strings.TrimSpace(s.AIHomeDir())
	if root == "" {
		return &accountLoginStore{jobs: map[string]*AccountLoginJob{}}
	}
	accountLoginStoresMu.Lock()
	defer accountLoginStoresMu.Unlock()
	if store, ok := accountLoginStores[root]; ok {
		return store
	}
	store := &accountLoginStore{
		path: filepath.Join(root, "plugins", accountLoginJobFile),
		jobs: map[string]*AccountLoginJob{},
	}
	store.load()
	accountLoginStores[root] = store
	return store
}

func (store *accountLoginStore) load() {
	raw, err := os.ReadFile(store.path)
	if err != nil {
		return
	}
	var document struct {
		Jobs []*AccountLoginJob `json:"jobs"`
	}
	if json.Unmarshal(raw, &document) != nil {
		return
	}
	for _, job := range document.Jobs {
		if job == nil || strings.TrimSpace(job.JobID) == "" {
			continue
		}
		store.jobs[job.JobID] = job
	}
}

func (store *accountLoginStore) persistLocked() {
	if store.path == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(store.path), 0o700)
	jobs := make([]*AccountLoginJob, 0, len(store.jobs))
	for _, job := range store.jobs {
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].CreatedAt < jobs[j].CreatedAt })
	if len(jobs) > accountLoginMaxJobs {
		jobs = jobs[len(jobs)-accountLoginMaxJobs:]
	}
	encoded, err := json.MarshalIndent(map[string]any{
		"schemaVersion": 1,
		"jobs":          jobs,
	}, "", "  ")
	if err != nil {
		return
	}
	temp := fmt.Sprintf("%s.%d.tmp", store.path, os.Getpid())
	if os.WriteFile(temp, append(encoded, '\n'), 0o600) != nil {
		return
	}
	if os.Rename(temp, store.path) != nil {
		_ = os.Remove(temp)
	}
}

func (store *accountLoginStore) pruneLocked(now int64) bool {
	changed := false
	for id, job := range store.jobs {
		if job.Status == "waiting_user" && job.ExpiresAt > 0 && job.ExpiresAt <= now {
			job.Status = "expired"
			job.Error = "设备码/登录任务已过期"
			job.UpdatedAt = now
			changed = true
		}
		_ = id
	}
	if len(store.jobs) > accountLoginMaxJobs {
		jobs := make([]*AccountLoginJob, 0, len(store.jobs))
		for _, job := range store.jobs {
			jobs = append(jobs, job)
		}
		sort.Slice(jobs, func(i, j int) bool { return jobs[i].CreatedAt < jobs[j].CreatedAt })
		for _, job := range jobs[:len(jobs)-accountLoginMaxJobs] {
			delete(store.jobs, job.JobID)
		}
		changed = true
	}
	return changed
}

// StartAccountLogin 启动一次插件登录，返回宿主任务视图。
func (s *Service) StartAccountLogin(ctx context.Context, req AccountLoginStartRequest) (AccountLoginJob, error) {
	provider, err := normalizeAccountProvider(req.Provider)
	if err != nil {
		return AccountLoginJob{}, err
	}
	sourceID := strings.TrimSpace(req.SourceID)
	if sourceID == "" {
		return AccountLoginJob{}, pluginerr.New("account_source_id_required", "sourceId 不能为空")
	}
	if s == nil || s.runtime == nil {
		return AccountLoginJob{}, pluginerr.New("plugin_runtime_inactive", "插件运行时未启动")
	}
	listing, err := s.ListAccountSources(ctx, provider, AccountListOptions{})
	if err != nil {
		return AccountLoginJob{}, err
	}
	var source *AccountSource
	for i := range listing.Sources {
		if listing.Sources[i].ID == sourceID {
			source = &listing.Sources[i]
			break
		}
	}
	if source == nil {
		return AccountLoginJob{}, pluginerr.New("auth_source_unknown", "未知认证来源："+sourceID)
	}
	if !source.Available {
		return AccountLoginJob{}, pluginerr.New("auth_source_unavailable", "认证来源当前不可用")
	}

	lease := s.runtime.Acquire()
	if lease == nil {
		return AccountLoginJob{}, pluginerr.New("plugin_runtime_inactive", "插件运行时未启动")
	}
	defer lease.Release()

	loginContribution, findErr := findLoginContribution(lease.Snapshot.Projection, *source)
	if findErr != nil {
		return AccountLoginJob{}, findErr
	}
	if loginContribution == nil {
		return AccountLoginJob{}, pluginerr.New("account_login_unsupported", "来源没有对应的登录插件")
	}
	runtimeDir, dirErr := s.resolveAccountRuntimeDir(provider, req.RuntimeDir)
	if dirErr != nil {
		return AccountLoginJob{}, dirErr
	}
	if mkErr := os.MkdirAll(runtimeDir, 0o700); mkErr != nil {
		return AccountLoginJob{}, pluginerr.New("invalid_login_runtime", "登录运行目录不可创建")
	}

	raw, invokeErr := s.runtime.Invoke(ctx, lease.Generation, loginContribution.ID, map[string]any{
		"schemaVersion": 1,
		"kind":          "start",
		"provider":      provider,
		"sourceId":      sourceID,
		"runtimeDir":    runtimeDir,
	}, accountLoginTimeout(req.TimeoutMs))
	if invokeErr != nil {
		return AccountLoginJob{}, invokeErr
	}
	result, normErr := normalizeAccountLoginResult(raw)
	if normErr != nil {
		return AccountLoginJob{}, normErr
	}

	now := time.Now().UnixMilli()
	job := AccountLoginJob{
		JobID:                   randomAccountLoginID(),
		Provider:                provider,
		SourceID:                sourceID,
		AuthMode:                source.AuthMode,
		ContributionID:          loginContribution.ID,
		InstanceID:              loginContribution.InstanceID,
		PluginJobID:             result.JobID,
		RuntimeDir:              runtimeDir,
		Status:                  result.Status,
		Message:                 result.Message,
		VerificationURI:         result.VerificationURI,
		VerificationURIComplete: result.VerificationURIComplete,
		UserCode:                result.UserCode,
		AuthorizationURL:        result.AuthorizationURL,
		RedirectURI:             result.RedirectURI,
		IntervalMs:              result.IntervalMs,
		CanSubmit:               result.CanSubmit,
		SubmitLabel:             result.SubmitLabel,
		SubmitPlaceholder:       result.SubmitPlaceholder,
		CreatedAt:               now,
		UpdatedAt:               now,
		ExpiresAt:               result.ExpiresAt,
	}
	if job.PluginJobID == "" {
		job.PluginJobID = job.JobID
	}
	if job.ExpiresAt <= 0 || job.ExpiresAt > now+int64(accountLoginJobTTL/time.Millisecond) {
		job.ExpiresAt = now + int64(accountLoginJobTTL/time.Millisecond)
	}

	store := s.accountLoginStore()
	store.mu.Lock()
	defer store.mu.Unlock()
	job = s.applyAccountLoginResultLocked(ctx, lease, store, job, result)
	return job, nil
}

// PollAccountLogin 推进等待中的登录任务。
func (s *Service) PollAccountLogin(ctx context.Context, jobID string) (AccountLoginJob, error) {
	store := s.accountLoginStore()
	store.mu.Lock()
	if store.pruneLocked(time.Now().UnixMilli()) {
		store.persistLocked()
	}
	job, ok := store.jobs[strings.TrimSpace(jobID)]
	if !ok {
		store.mu.Unlock()
		return AccountLoginJob{}, pluginerr.New("account_login_job_not_found", "登录任务不存在或已过期")
	}
	if job.Status != "waiting_user" {
		out := *job
		store.mu.Unlock()
		return out, nil
	}
	if job.ExpiresAt > 0 && job.ExpiresAt <= time.Now().UnixMilli() {
		job.Status = "expired"
		job.Error = "登录任务已过期"
		job.UpdatedAt = time.Now().UnixMilli()
		store.persistLocked()
		out := *job
		store.mu.Unlock()
		return out, nil
	}
	snapshot := *job
	store.mu.Unlock()

	if s == nil || s.runtime == nil {
		return AccountLoginJob{}, pluginerr.New("plugin_runtime_inactive", "插件运行时未启动")
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return AccountLoginJob{}, pluginerr.New("plugin_runtime_inactive", "插件运行时未启动")
	}
	defer lease.Release()
	raw, err := s.runtime.Invoke(ctx, lease.Generation, snapshot.ContributionID, map[string]any{
		"schemaVersion": 1,
		"kind":          "poll",
		"provider":      snapshot.Provider,
		"sourceId":      snapshot.SourceID,
		"jobId":         snapshot.PluginJobID,
		"runtimeDir":    snapshot.RuntimeDir,
	}, accountLoginDefaultTimeout)
	if err != nil {
		return AccountLoginJob{}, err
	}
	result, err := normalizeAccountLoginResult(raw)
	if err != nil {
		return AccountLoginJob{}, err
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	current, ok := store.jobs[snapshot.JobID]
	if !ok {
		return snapshot, nil
	}
	return s.applyAccountLoginResultLocked(ctx, lease, store, *current, result), nil
}

// SubmitAccountLogin 把用户粘贴的授权码/回调地址交给插件。
func (s *Service) SubmitAccountLogin(ctx context.Context, jobID, value string) (AccountLoginJob, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return AccountLoginJob{}, pluginerr.New("account_login_submit_value_required", "提交值不能为空")
	}
	if len([]byte(value)) > accountLoginSubmitMaxBytes {
		return AccountLoginJob{}, pluginerr.New("account_login_submit_value_too_large", "提交值过大")
	}
	store := s.accountLoginStore()
	store.mu.Lock()
	if store.pruneLocked(time.Now().UnixMilli()) {
		store.persistLocked()
	}
	job, ok := store.jobs[strings.TrimSpace(jobID)]
	if !ok {
		store.mu.Unlock()
		return AccountLoginJob{}, pluginerr.New("account_login_job_not_found", "登录任务不存在或已过期")
	}
	if job.Status != "waiting_user" {
		out := *job
		store.mu.Unlock()
		return out, nil
	}
	if !job.CanSubmit {
		store.mu.Unlock()
		return AccountLoginJob{}, pluginerr.New("account_login_submit_unsupported", "该登录任务不接受提交值")
	}
	snapshot := *job
	store.mu.Unlock()

	if s == nil || s.runtime == nil {
		return AccountLoginJob{}, pluginerr.New("plugin_runtime_inactive", "插件运行时未启动")
	}
	lease := s.runtime.Acquire()
	if lease == nil {
		return AccountLoginJob{}, pluginerr.New("plugin_runtime_inactive", "插件运行时未启动")
	}
	defer lease.Release()
	raw, err := s.runtime.Invoke(ctx, lease.Generation, snapshot.ContributionID, map[string]any{
		"schemaVersion": 1,
		"kind":          "submit",
		"provider":      snapshot.Provider,
		"sourceId":      snapshot.SourceID,
		"jobId":         snapshot.PluginJobID,
		"runtimeDir":    snapshot.RuntimeDir,
		"value":         value,
	}, accountLoginDefaultTimeout)
	if err != nil {
		return AccountLoginJob{}, err
	}
	result, err := normalizeAccountLoginResult(raw)
	if err != nil {
		return AccountLoginJob{}, err
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	current, ok := store.jobs[snapshot.JobID]
	if !ok {
		return snapshot, nil
	}
	s.Audit("account_login_submit", map[string]any{
		"provider": snapshot.Provider, "sourceId": snapshot.SourceID,
		"jobId": snapshot.JobID, "status": result.Status,
	})
	return s.applyAccountLoginResultLocked(ctx, lease, store, *current, result), nil
}

// CancelAccountLogin 终止任务并尽力通知插件。
func (s *Service) CancelAccountLogin(ctx context.Context, jobID string) (AccountLoginJob, error) {
	store := s.accountLoginStore()
	store.mu.Lock()
	job, ok := store.jobs[strings.TrimSpace(jobID)]
	if !ok {
		store.mu.Unlock()
		return AccountLoginJob{}, pluginerr.New("account_login_job_not_found", "登录任务不存在")
	}
	snapshot := *job
	store.mu.Unlock()

	// 终态是事实，cancel 不能把它改写成 cancelled（Node 旧实现会覆盖，
	// 这会让已经成功的登录在界面上变成取消）。终态直接返回当前视图。
	if snapshot.Status != "waiting_user" {
		return snapshot, nil
	}

	if snapshot.Status == "waiting_user" && snapshot.PluginJobID != "" && s != nil && s.runtime != nil {
		if lease := s.runtime.Acquire(); lease != nil {
			_, _ = s.runtime.Invoke(ctx, lease.Generation, snapshot.ContributionID, map[string]any{
				"schemaVersion": 1,
				"kind":          "cancel",
				"provider":      snapshot.Provider,
				"sourceId":      snapshot.SourceID,
				"jobId":         snapshot.PluginJobID,
				"runtimeDir":    snapshot.RuntimeDir,
			}, 3*time.Second)
			lease.Release()
		}
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	current, ok := store.jobs[snapshot.JobID]
	if !ok {
		return snapshot, nil
	}
	current.Status = "cancelled"
	current.Error = ""
	current.PluginJobID = ""
	current.UpdatedAt = time.Now().UnixMilli()
	current.ExpiresAt = 0
	store.persistLocked()
	s.Audit("account_login", map[string]any{
		"provider": current.Provider, "sourceId": current.SourceID,
		"accountRef": current.AccountRef, "status": "cancelled",
	})
	return *current, nil
}

// GetAccountLogin 读取任务当前状态（会先清理过期任务）。
func (s *Service) GetAccountLogin(jobID string) (AccountLoginJob, bool) {
	store := s.accountLoginStore()
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.pruneLocked(time.Now().UnixMilli()) {
		store.persistLocked()
	}
	job, ok := store.jobs[strings.TrimSpace(jobID)]
	if !ok {
		return AccountLoginJob{}, false
	}
	return *job, true
}

// applyAccountLoginResultLocked 合并插件返回值；成功时落盘投影并注册账号。
func (s *Service) applyAccountLoginResultLocked(
	ctx context.Context,
	lease *Lease,
	store *accountLoginStore,
	job AccountLoginJob,
	result accountLoginPluginResult,
) AccountLoginJob {
	job.Message = result.Message
	job.VerificationURI = result.VerificationURI
	job.VerificationURIComplete = result.VerificationURIComplete
	job.UserCode = result.UserCode
	job.AuthorizationURL = result.AuthorizationURL
	job.RedirectURI = result.RedirectURI
	job.IntervalMs = result.IntervalMs
	job.CanSubmit = result.CanSubmit || job.CanSubmit
	if result.SubmitLabel != "" {
		job.SubmitLabel = result.SubmitLabel
	}
	if result.SubmitPlaceholder != "" {
		job.SubmitPlaceholder = result.SubmitPlaceholder
	}
	job.UpdatedAt = time.Now().UnixMilli()

	switch result.Status {
	case "failed":
		job.Status = "failed"
		job.Error = strings.TrimSpace(result.Message)
		if job.Error == "" {
			job.Error = "登录失败"
		}
		job.PluginJobID = ""
		job.ExpiresAt = 0
		store.jobs[job.JobID] = &job
		store.persistLocked()
		return job
	case "success":
		return s.finishAccountLoginLocked(ctx, lease, store, job, result)
	default:
		job.Status = "waiting_user"
		if result.JobID != "" {
			job.PluginJobID = result.JobID
		}
		store.jobs[job.JobID] = &job
		store.persistLocked()
		return job
	}
}

func (s *Service) finishAccountLoginLocked(
	ctx context.Context,
	lease *Lease,
	store *accountLoginStore,
	job AccountLoginJob,
	result accountLoginPluginResult,
) AccountLoginJob {
	source := AccountSource{
		Provider:         job.Provider,
		PluginInstanceID: job.InstanceID,
	}
	raw := map[string]any{}
	if len(result.Files) > 0 {
		raw["files"] = json.RawMessage(result.Files)
	}
	if len(result.Credential) > 0 {
		raw["credential"] = json.RawMessage(result.Credential)
	}
	encoded, _ := json.Marshal(raw)
	files, removed, err := s.resolveSourceFiles(ctx, lease, &source, json.RawMessage(encoded), job.RuntimeDir, accountLoginDefaultTimeout)
	if err != nil || len(files) == 0 {
		return s.failAccountLoginLocked(store, job, "account_plugin_files_missing", "登录成功但插件没有返回投影文件")
	}
	if _, writeErr := WriteProjectionFiles(job.RuntimeDir, files, removed); writeErr != nil {
		return s.failAccountLoginLocked(store, job, "account_plugin_registration_failed", writeErr.Error())
	}
	registration, regErr := registerProjectionOrError(ctx, s.accountRegistrarForLogin(), ProjectionRegisterRequest{
		Provider:   job.Provider,
		RuntimeDir: job.RuntimeDir,
	})
	if regErr != nil {
		return s.failAccountLoginLocked(store, job, firstNonEmpty(errorCode(regErr), "account_plugin_registration_failed"), regErr.Error())
	}
	job.Status = "success"
	job.AccountRef = registration.AccountRef
	job.CLIAccountID = registration.CLIAccountID
	job.PluginJobID = ""
	job.ExpiresAt = 0
	job.UpdatedAt = time.Now().UnixMilli()
	store.jobs[job.JobID] = &job
	store.persistLocked()
	if s != nil {
		s.Audit("account_login", map[string]any{
			"provider": job.Provider, "sourceId": job.SourceID,
			"accountRef": job.AccountRef, "status": job.Status,
		})
	}
	return job
}

func (s *Service) failAccountLoginLocked(store *accountLoginStore, job AccountLoginJob, code, message string) AccountLoginJob {
	job.Status = "failed"
	message = strings.TrimSpace(message)
	if message == "" {
		job.Error = code
	} else {
		job.Error = code + "：" + message
	}
	job.PluginJobID = ""
	job.UpdatedAt = time.Now().UnixMilli()
	job.ExpiresAt = 0
	store.jobs[job.JobID] = &job
	store.persistLocked()
	if s != nil {
		s.Audit("account_login", map[string]any{
			"provider": job.Provider, "sourceId": job.SourceID,
			"accountRef": job.AccountRef, "status": job.Status, "error": job.Error,
		})
	}
	return job
}

// accountRegistrarForLogin 返回登录成功后登记投影的端口。
//
// Service 本身不持有账号库；组合根通过 SetAccountProjectionRegistrar 注入。
// 未注入时失败关闭，避免登录成功却没有任何账号入库。
func (s *Service) accountRegistrarForLogin() AccountProjectionRegistrar {
	if s == nil {
		return nil
	}
	return s.accountProjectionRegistrar
}

// SetAccountProjectionRegistrar 注入账号投影登记端口（由组合根调用一次）。
func (s *Service) SetAccountProjectionRegistrar(registrar AccountProjectionRegistrar) {
	if s == nil {
		return
	}
	s.accountProjectionRegistrar = registrar
}

func normalizeAccountLoginResult(raw json.RawMessage) (accountLoginPluginResult, error) {
	var value struct {
		Status                  string          `json:"status"`
		JobID                   string          `json:"jobId"`
		Message                 string          `json:"message"`
		VerificationURI         string          `json:"verificationUri"`
		VerificationURIComplete string          `json:"verificationUriComplete"`
		UserCode                string          `json:"userCode"`
		AuthorizationURL        string          `json:"authorizationUrl"`
		RedirectURI             string          `json:"redirectUri"`
		IntervalMs              int64           `json:"intervalMs"`
		CanSubmit               bool            `json:"canSubmit"`
		SubmitLabel             string          `json:"submitLabel"`
		SubmitPlaceholder       string          `json:"submitPlaceholder"`
		ExpiresAt               int64           `json:"expiresAt"`
		Files                   json.RawMessage `json:"files"`
		Credential              json.RawMessage `json:"credential"`
		Removed                 []string        `json:"removed"`
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return accountLoginPluginResult{}, pluginerr.New("account_plugin_login_result_invalid", "登录返回值为空")
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return accountLoginPluginResult{}, pluginerr.New("account_plugin_login_result_invalid", "登录返回值不是合法 JSON 对象")
	}
	status := strings.ToLower(strings.TrimSpace(value.Status))
	if !accountLoginStatuses[status] {
		return accountLoginPluginResult{}, pluginerr.New("account_plugin_login_status_invalid", "登录状态无效："+status)
	}
	result := accountLoginPluginResult{
		Status:                  status,
		JobID:                   strings.TrimSpace(value.JobID),
		Message:                 strings.TrimSpace(value.Message),
		VerificationURI:         normalizeLoginURL(value.VerificationURI, "verificationUri"),
		VerificationURIComplete: normalizeLoginURL(value.VerificationURIComplete, "verificationUriComplete"),
		UserCode:                truncateText(strings.TrimSpace(value.UserCode), 128),
		AuthorizationURL:        normalizeLoginURL(value.AuthorizationURL, "authorizationUrl"),
		RedirectURI:             normalizeLoginURL(value.RedirectURI, "redirectUri"),
		IntervalMs:              value.IntervalMs,
		CanSubmit:               value.CanSubmit,
		SubmitLabel:             truncateText(strings.TrimSpace(value.SubmitLabel), 64),
		SubmitPlaceholder:       truncateText(strings.TrimSpace(value.SubmitPlaceholder), 256),
		ExpiresAt:               value.ExpiresAt,
		Files:                   value.Files,
		Credential:              value.Credential,
		Removed:                 value.Removed,
	}
	if result.IntervalMs < 1000 {
		result.IntervalMs = 5000
	}
	return result, nil
}

func normalizeLoginURL(raw, field string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	lower := strings.ToLower(text)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return ""
	}
	return text
}

func truncateText(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}

func accountLoginTimeout(timeoutMs int) time.Duration {
	if timeoutMs > 0 {
		return time.Duration(timeoutMs) * time.Millisecond
	}
	return accountLoginDefaultTimeout
}

func randomAccountLoginID() string {
	var buf [16]byte
	if _, err := randRead(buf[:]); err != nil {
		return fmt.Sprintf("login-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

// randRead 是 crypto/rand.Read 的轻量别名，便于测试替换。
var randRead = func(buffer []byte) (int, error) {
	return cryptorand.Read(buffer)
}
