// Package codebuddymodels 维护 CodeBuddy 家族「AIH Server 网关档」的 models.json。
//
// 背景：CodeBuddy 没有 OpenAI 兼容的 base URL 环境变量入口（CODEBUDDY_BASE_URL 只覆盖
// 产品自己的 Chat 协议，官方文档明确要求第三方模型写 models.json）。因此网关档必须把
// AIH Server 当作一组自定义模型投影进一个**独立**的 config dir；不能写宿主共享的
// ~/.codebuddy/models.json —— 家族账号投影会把它链接进每个账号沙箱，网关模型一旦混入，
// `aih codebuddy <id>` 的账号钉选就会被这些自定义模型绕开。
//
// 本包只做三件事：
//  1. 从网关 /v1/models 读取当前可路由目录；
//  2. 把目录合并成 models.json（保留非 AIH 条目与用户附加字段）；
//  3. 用防抖 + 跨进程锁 + 原子替换，处理并发刷新与 CodeBuddy 自己的热重载写入。
package codebuddymodels

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// ManagedVendor 是 models.json 条目的所有权标记。
	//
	// 不使用自定义字段：CodeBuddy 的 UI 只认识 schema 里的字段，未知字段可能在它保存
	// 文件时被丢弃；vendor 是合法字段且会原样保留。
	ManagedVendor = "AIH Server"
	// GatewayAPIKeyEnv 是模型 apiKey 引用的环境变量名。
	//
	// 文件里只写 ${AIH_GATEWAY_API_KEY}，真正的客户端密钥由启动策略注入子进程环境，
	// 避免本地网关密钥以明文形式长期留在 models.json。
	GatewayAPIKeyEnv         = "AIH_GATEWAY_API_KEY"
	GatewayAPIKeyPlaceholder = "${" + GatewayAPIKeyEnv + "}"

	// ModelsFileName 是该投影唯一维护的文件名。
	ModelsFileName = "models.json"
	// DefaultDebounce 合并同一批账号/模型变更事件。
	DefaultDebounce = 500 * time.Millisecond
	// DefaultReconcileInterval 是漏事件时的兜底对账周期。
	DefaultReconcileInterval = 30 * time.Second
	// lockStaleAfter 之后视为上次持有者已崩溃，允许抢占锁文件。
	lockStaleAfter = 30 * time.Second
	// lockWaitTimeout 是等待同一文件其它写入者的上限。
	lockWaitTimeout = 3 * time.Second
	// catalogTimeout 限制 /v1/models 读取时间。
	catalogTimeout = 10 * time.Second
	// maxCatalogBytes 限制目录响应体，避免异常响应拖垮进程。
	maxCatalogBytes = 8 << 20
)

var (
	// ErrRootDirMissing 表示没有可用的投影根目录。
	ErrRootDirMissing = errors.New("CodeBuddy 模型投影根目录缺失")
	// ErrConnectionMissing 表示缺少网关地址或客户端密钥。
	ErrConnectionMissing = errors.New("CodeBuddy 模型投影缺少网关连接")
	// ErrCatalogUnavailable 表示网关模型目录读取失败。
	ErrCatalogUnavailable = errors.New("CodeBuddy 模型目录不可用")
	// ErrCatalogEmpty 表示网关返回了空目录（不覆盖已有投影）。
	ErrCatalogEmpty = errors.New("CodeBuddy 模型目录为空")
)

// Options 是投影管理器的构造参数。
type Options struct {
	// RootDir 是投影根目录（通常是 <aiHome>/run/codebuddy-gateway）。
	RootDir string
	// HTTPClient 只用于读取网关模型目录；为空时使用带超时的默认客户端。
	HTTPClient *http.Client
	// Debounce 覆盖默认防抖窗口。
	Debounce time.Duration
	// ReconcileInterval 覆盖默认兜底对账周期；<=0 时使用默认值。
	ReconcileInterval time.Duration
	// Logf 接收刷新结果与错误；为空时静默。
	Logf func(format string, args ...any)
}

type connection struct {
	baseURL string
	apiKey  string
}

// Manager 维护一个 models.json 投影。
type Manager struct {
	rootDir    string
	httpClient *http.Client
	debounce   time.Duration
	reconcile  time.Duration
	logf       func(format string, args ...any)

	connMu sync.RWMutex
	conn   connection

	triggerMu sync.Mutex
	timer     *time.Timer

	refreshMu  sync.Mutex
	refreshing bool
	pending    bool

	startOnce sync.Once
	stopOnce  sync.Once
	stop      chan struct{}
	done      chan struct{}
}

// New 创建投影管理器。RootDir 为空时返回一个禁用实例（Ensure 会失败，Start 无操作）。
func New(options Options) *Manager {
	rootDir := strings.TrimSpace(options.RootDir)
	httpClient := options.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: catalogTimeout + 5*time.Second}
	}
	debounce := options.Debounce
	if debounce <= 0 {
		debounce = DefaultDebounce
	}
	reconcile := options.ReconcileInterval
	if reconcile <= 0 {
		reconcile = DefaultReconcileInterval
	}
	return &Manager{
		rootDir:    rootDir,
		httpClient: httpClient,
		debounce:   debounce,
		reconcile:  reconcile,
		logf:       options.Logf,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
}

// RootDir 返回投影根目录。
func (manager *Manager) RootDir() string {
	if manager == nil {
		return ""
	}
	return manager.rootDir
}

// ModelsPath 返回 models.json 的绝对路径。
func (manager *Manager) ModelsPath() string {
	if manager == nil || manager.rootDir == "" {
		return ""
	}
	return filepath.Join(manager.rootDir, ModelsFileName)
}

// SetConnection 更新网关连接，供异步刷新使用。
func (manager *Manager) SetConnection(baseURL string, apiKey string) {
	if manager == nil {
		return
	}
	normalizedURL := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	key := strings.TrimSpace(apiKey)
	if normalizedURL == "" || key == "" {
		return
	}
	manager.connMu.Lock()
	manager.conn = connection{baseURL: normalizedURL, apiKey: key}
	manager.connMu.Unlock()
}

func (manager *Manager) readConnection() connection {
	if manager == nil {
		return connection{}
	}
	manager.connMu.RLock()
	defer manager.connMu.RUnlock()
	return manager.conn
}

// Ensure 立即读取一次网关目录并同步投影，返回适合作为默认模型的模型 ID。
//
// 返回的 error 不为 nil 时，defaultModel 仍可能来自上一次成功投影（调用方可以继续
// 启动，让用户看到具体请求错误，而不是被启动器拦死）。
func (manager *Manager) Ensure(
	ctx context.Context,
	baseURL string,
	apiKey string,
) (string, error) {
	if manager == nil || manager.rootDir == "" {
		return "", ErrRootDirMissing
	}
	manager.SetConnection(baseURL, apiKey)
	_, defaultModel, err := manager.refresh(ctx)
	return defaultModel, err
}

// Trigger 请求一次防抖刷新；同一个窗口内的多次触发只执行一次。
func (manager *Manager) Trigger() {
	if manager == nil || manager.rootDir == "" {
		return
	}
	if manager.readConnection().baseURL == "" {
		return
	}
	manager.triggerMu.Lock()
	if manager.timer != nil {
		manager.triggerMu.Unlock()
		return
	}
	manager.timer = time.AfterFunc(manager.debounce, func() {
		manager.triggerMu.Lock()
		manager.timer = nil
		manager.triggerMu.Unlock()
		manager.refreshAsync(context.Background())
	})
	manager.triggerMu.Unlock()
}

func (manager *Manager) refreshAsync(ctx context.Context) {
	manager.refreshMu.Lock()
	if manager.refreshing {
		manager.pending = true
		manager.refreshMu.Unlock()
		return
	}
	manager.refreshing = true
	manager.refreshMu.Unlock()

	updated, _, err := manager.refresh(ctx)

	manager.refreshMu.Lock()
	manager.refreshing = false
	pending := manager.pending
	manager.pending = false
	manager.refreshMu.Unlock()

	if err != nil {
		manager.logf("刷新失败: %v", err)
	} else if updated {
		manager.logf("已更新 %s", manager.ModelsPath())
	}
	if pending {
		manager.Trigger()
	}
}

// Start 启动兜底对账循环，并在服务启动后做一次初始刷新。
func (manager *Manager) Start(ctx context.Context) {
	if manager == nil || manager.rootDir == "" {
		return
	}
	manager.startOnce.Do(func() {
		go manager.loop(ctx)
	})
}

func (manager *Manager) loop(ctx context.Context) {
	defer close(manager.done)
	initial := time.NewTimer(2 * time.Second)
	defer initial.Stop()
	ticker := time.NewTicker(manager.reconcile)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-manager.stop:
			return
		case <-initial.C:
			manager.refreshAsync(ctx)
		case <-ticker.C:
			manager.refreshAsync(ctx)
		}
	}
}

// Close 停止后台循环，幂等。
func (manager *Manager) Close() error {
	if manager == nil {
		return nil
	}
	manager.stopOnce.Do(func() {
		close(manager.stop)
	})
	select {
	case <-manager.done:
	case <-time.After(2 * time.Second):
	}
	return nil
}

// refresh 执行一次「拉目录 → 合并 → 原子写」。updated 表示文件内容是否变化。
func (manager *Manager) refresh(ctx context.Context) (bool, string, error) {
	conn := manager.readConnection()
	if conn.baseURL == "" || conn.apiKey == "" {
		return false, cachedDefaultModel(manager.ModelsPath()), ErrConnectionMissing
	}
	catalogCtx, cancel := context.WithTimeout(ctx, catalogTimeout)
	defer cancel()
	rows, err := manager.fetchCatalog(catalogCtx, conn)
	if err != nil {
		return false, cachedDefaultModel(manager.ModelsPath()), err
	}
	entries := BuildEntries(rows, ChatCompletionsURL(conn.baseURL))
	if len(entries) == 0 {
		return false, cachedDefaultModel(manager.ModelsPath()), ErrCatalogEmpty
	}
	defaultModel := PreferredDefaultModel(entries)
	updated, err := manager.writeProjection(entries)
	return updated, defaultModel, err
}

// CatalogRow 是 /v1/models 的一行事实。
type CatalogRow struct {
	ID               string
	OwnedBy          string
	InputModalities  []string
	OutputModalities []string
	ReasoningEfforts []string
}

type catalogResponse struct {
	Data []struct {
		ID               string   `json:"id"`
		OwnedBy          string   `json:"owned_by"`
		ReasoningEfforts []string `json:"aih_reasoning_efforts"`
		Modalities       *struct {
			Input  []string `json:"input"`
			Output []string `json:"output"`
		} `json:"aih_modalities"`
	} `json:"data"`
}

func (manager *Manager) fetchCatalog(
	ctx context.Context,
	conn connection,
) ([]CatalogRow, error) {
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		conn.baseURL+"/v1/models",
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("%w: 构造请求失败", ErrCatalogUnavailable)
	}
	request.Header.Set("Authorization", "Bearer "+conn.apiKey)
	request.Header.Set("Accept", "application/json")
	response, err := manager.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrCatalogUnavailable, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxCatalogBytes))
		_ = response.Body.Close()
	}()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: HTTP %d", ErrCatalogUnavailable, response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxCatalogBytes))
	if err != nil {
		return nil, fmt.Errorf("%w: 读取响应失败", ErrCatalogUnavailable)
	}
	var parsed catalogResponse
	if err := json.Unmarshal(payload, &parsed); err != nil {
		return nil, fmt.Errorf("%w: 响应结构无效", ErrCatalogUnavailable)
	}
	rows := make([]CatalogRow, 0, len(parsed.Data))
	for _, row := range parsed.Data {
		id := strings.TrimSpace(row.ID)
		if id == "" {
			continue
		}
		item := CatalogRow{
			ID:               id,
			OwnedBy:          strings.TrimSpace(row.OwnedBy),
			ReasoningEfforts: normalizeStrings(row.ReasoningEfforts),
		}
		if row.Modalities != nil {
			item.InputModalities = normalizeStrings(row.Modalities.Input)
			item.OutputModalities = normalizeStrings(row.Modalities.Output)
		}
		rows = append(rows, item)
	}
	return rows, nil
}

// ChatCompletionsURL 由网关根地址生成 CodeBuddy 需要的完整接口路径。
func ChatCompletionsURL(baseURL string) string {
	return strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/v1/chat/completions"
}

// BuildEntries 把网关目录转换成 models.json 条目。
//
// 只保留能产出文本的模型：纯生图模型出现在 CodeBuddy 的聊天模型选择器里，
// 选中后每一轮都会失败。
func BuildEntries(rows []CatalogRow, chatURL string) []map[string]any {
	entries := make([]map[string]any, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		id := strings.TrimSpace(row.ID)
		if id == "" {
			continue
		}
		if _, found := seen[id]; found {
			continue
		}
		if len(row.OutputModalities) > 0 && !containsFold(row.OutputModalities, "text") {
			continue
		}
		seen[id] = struct{}{}

		entry := map[string]any{
			"id":                id,
			"name":              id,
			"vendor":            ManagedVendor,
			"url":               chatURL,
			"apiKey":            GatewayAPIKeyPlaceholder,
			"supportsToolCall":  true,
			"supportsImages":    containsFold(row.InputModalities, "image"),
			"supportsReasoning": len(row.ReasoningEfforts) > 0,
		}
		if row.OwnedBy != "" {
			entry["description"] = ManagedVendor + " · " + row.OwnedBy
		} else {
			entry["description"] = ManagedVendor
		}
		if len(row.ReasoningEfforts) > 0 {
			entry["reasoning"] = map[string]any{
				"defaultEffort":    preferredEffort(row.ReasoningEfforts),
				"supportedEfforts": append([]string(nil), row.ReasoningEfforts...),
			}
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		return stringField(entries[i], "id") < stringField(entries[j], "id")
	})
	return entries
}

// PreferredDefaultModel 选一个适合作为 CODEBUDDY_MODEL 默认值的具体模型。
//
// 别名（auto / balanced-model）能路由但不适合当默认；先选能接受 CodeBuddy 大系统
// 提示的具体模型，再按知名模型族回退。默认值只是启动建议，用户随时可用 --model 覆盖。
//
// 2026-11-21 实测：CodeBuddy 2.185.0 的完整系统提示（约 2.7 万字符）在国内站网关的
// 部分 Claude/别名路由会被上游以 400 拒绝，deepseek-v4-pro 可以稳定接受；因此把它
// 放在首位，而不是按“最强模型”排序。
func PreferredDefaultModel(entries []map[string]any) string {
	preferences := []string{
		"deepseek-v4-pro",
		"claude-opus",
		"claude-sonnet",
		"gpt-",
		"deepseek",
		"glm",
		"kimi",
		"minimax",
		"qwen",
		"mimo",
	}
	aliases := map[string]struct{}{
		"auto": {}, "balanced-model": {}, "decision-model-preview": {},
		"default-model": {}, "fast-model": {}, "primary-model": {},
	}
	candidates := make([]string, 0, len(entries))
	for _, entry := range entries {
		id := stringField(entry, "id")
		if _, alias := aliases[strings.ToLower(id)]; alias {
			continue
		}
		candidates = append(candidates, id)
	}
	if len(candidates) == 0 {
		return ""
	}
	sort.Strings(candidates)
	// 精确匹配优先：`deepseek-v4-pro` 与 `cline-pass/deepseek-v4-pro` 都包含偏好
	// 子串，但后者是 Provider 命名空间模型，可能要求该 Provider 的原生登录态
	// （2026-11-21 实测 cline-pass 路由返回 422）。默认值必须选裸模型。
	for _, preference := range preferences {
		for _, id := range candidates {
			if strings.EqualFold(id, preference) {
				return id
			}
		}
	}
	for _, preference := range preferences {
		for _, id := range candidates {
			if !strings.Contains(id, "/") && strings.Contains(strings.ToLower(id), preference) {
				return id
			}
		}
	}
	for _, id := range candidates {
		if !strings.Contains(id, "/") {
			return id
		}
	}
	return candidates[0]
}

func preferredEffort(efforts []string) string {
	for _, effort := range efforts {
		if strings.EqualFold(effort, "high") {
			return "high"
		}
	}
	if len(efforts) == 0 {
		return ""
	}
	return efforts[len(efforts)-1]
}

func normalizeStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		item := strings.TrimSpace(value)
		if item == "" {
			continue
		}
		key := strings.ToLower(item)
		if _, found := seen[key]; found {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, item)
	}
	return out
}

func containsFold(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}

func stringField(entry map[string]any, key string) string {
	value, _ := entry[key].(string)
	return strings.TrimSpace(value)
}

// writeProjection 在跨进程锁内完成读-改-写，并在目标文件被其它进程改动时重试。
func (manager *Manager) writeProjection(desired []map[string]any) (bool, error) {
	path := manager.ModelsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return false, fmt.Errorf("创建 CodeBuddy 投影目录失败: %w", err)
	}
	return manager.withLock(path, func() (bool, error) {
		for attempt := 0; attempt < 3; attempt++ {
			before, readErr := readFileOrEmpty(path)
			if readErr != nil {
				return false, readErr
			}
			next, changed, mergeErr := mergeDocument(before, desired)
			if mergeErr != nil {
				return false, mergeErr
			}
			if !changed {
				return false, nil
			}
			// 乐观并发：读取后如果 CodeBuddy 自己保存了文件，重读再合并。
			after, statErr := readFileOrEmpty(path)
			if statErr != nil {
				return false, statErr
			}
			if sha256Hex(before) != sha256Hex(after) {
				continue
			}
			if err := writeFileAtomic(path, next); err != nil {
				return false, err
			}
			return true, nil
		}
		return false, errors.New("CodeBuddy 投影文件持续被并发修改")
	})
}

func (manager *Manager) withLock(
	path string,
	action func() (bool, error),
) (bool, error) {
	lockPath := path + ".aih.lock"
	deadline := time.Now().Add(lockWaitTimeout)
	for {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = fmt.Fprintf(file, "%d %d\n", os.Getpid(), time.Now().Unix())
			_ = file.Close()
			defer func() { _ = os.Remove(lockPath) }()
			return action()
		}
		if !os.IsExist(err) {
			return false, fmt.Errorf("创建 CodeBuddy 投影锁失败: %w", err)
		}
		if info, statErr := os.Stat(lockPath); statErr == nil &&
			time.Since(info.ModTime()) > lockStaleAfter {
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return false, errors.New("等待 CodeBuddy 投影锁超时")
		}
		time.Sleep(25 * time.Millisecond)
	}
}

// mergeDocument 把 desired 合并进现有文档。
//
// 所有权规则：
//   - vendor == AIH Server 的条目由本包管理：不在 desired 里的删除；
//   - 其它条目原样保留；若其 id 与 desired 冲突，保留用户条目并放弃本次注入；
//   - 更新已有托管条目时保留用户附加字段（disabled / temperature 等）。
func mergeDocument(
	current []byte,
	desired []map[string]any,
) ([]byte, bool, error) {
	fields, models, err := parseDocument(current)
	if err != nil {
		return nil, false, err
	}
	desiredByID := make(map[string]map[string]any, len(desired))
	for _, entry := range desired {
		id := stringField(entry, "id")
		if id == "" {
			continue
		}
		desiredByID[id] = entry
	}
	used := make(map[string]struct{}, len(desiredByID))
	nextModels := make([]map[string]any, 0, len(models)+len(desired))
	for _, existing := range models {
		id := stringField(existing, "id")
		if id == "" {
			nextModels = append(nextModels, existing)
			continue
		}
		wanted, wantedFound := desiredByID[id]
		if isManagedEntry(existing) {
			if !wantedFound {
				continue
			}
			nextModels = append(nextModels, mergeEntry(existing, wanted))
			used[id] = struct{}{}
			continue
		}
		// 非托管条目优先：不覆盖用户自己配置的同名模型。
		nextModels = append(nextModels, existing)
		if wantedFound {
			used[id] = struct{}{}
		}
	}
	extraIDs := make([]string, 0, len(desiredByID))
	for id := range desiredByID {
		if _, found := used[id]; found {
			continue
		}
		extraIDs = append(extraIDs, id)
	}
	sort.Strings(extraIDs)
	for _, id := range extraIDs {
		nextModels = append(nextModels, desiredByID[id])
	}

	if modelsEqual(models, nextModels) {
		return nil, false, nil
	}
	modelsJSON, err := json.Marshal(nextModels)
	if err != nil {
		return nil, false, fmt.Errorf("序列化 CodeBuddy 模型条目失败: %w", err)
	}
	fields["models"] = modelsJSON
	encoded, err := json.MarshalIndent(fields, "", "  ")
	if err != nil {
		return nil, false, fmt.Errorf("序列化 CodeBuddy 投影失败: %w", err)
	}
	encoded = append(encoded, '\n')
	return encoded, true, nil
}

func parseDocument(
	payload []byte,
) (map[string]json.RawMessage, []map[string]any, error) {
	trimmed := strings.TrimSpace(string(payload))
	if trimmed == "" {
		return map[string]json.RawMessage{}, nil, nil
	}
	// 官方兼容两种形态：{"models":[...]} 与顶级数组。
	if strings.HasPrefix(trimmed, "[") {
		var models []map[string]any
		if err := json.Unmarshal(payload, &models); err != nil {
			return nil, nil, fmt.Errorf("解析 CodeBuddy models.json 失败: %w", err)
		}
		return map[string]json.RawMessage{}, models, nil
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(payload, &fields); err != nil {
		return nil, nil, fmt.Errorf("解析 CodeBuddy models.json 失败: %w", err)
	}
	models := []map[string]any{}
	if raw, found := fields["models"]; found && len(raw) > 0 {
		if err := json.Unmarshal(raw, &models); err != nil {
			return nil, nil, fmt.Errorf("解析 CodeBuddy models.json 的 models 字段失败: %w", err)
		}
	}
	return fields, models, nil
}

func isManagedEntry(entry map[string]any) bool {
	vendor, _ := entry["vendor"].(string)
	return strings.EqualFold(strings.TrimSpace(vendor), ManagedVendor)
}

func mergeEntry(existing map[string]any, desired map[string]any) map[string]any {
	merged := make(map[string]any, len(existing)+len(desired))
	for key, value := range existing {
		merged[key] = value
	}
	for key, value := range desired {
		merged[key] = value
	}
	return merged
}

func modelsEqual(left []map[string]any, right []map[string]any) bool {
	if len(left) != len(right) {
		return false
	}
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	if leftErr != nil || rightErr != nil {
		return reflect.DeepEqual(left, right)
	}
	return string(leftJSON) == string(rightJSON)
}

func readFileOrEmpty(path string) ([]byte, error) {
	payload, err := os.ReadFile(path)
	if err == nil {
		return payload, nil
	}
	if os.IsNotExist(err) {
		return nil, nil
	}
	return nil, fmt.Errorf("读取 CodeBuddy 投影失败: %w", err)
}

func writeFileAtomic(path string, payload []byte) error {
	target := resolveWriteTarget(path)
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建 CodeBuddy 投影目录失败: %w", err)
	}
	temp := filepath.Join(
		dir,
		fmt.Sprintf(".models.json.aih-%d-%d", os.Getpid(), time.Now().UnixNano()),
	)
	file, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("创建 CodeBuddy 投影临时文件失败: %w", err)
	}
	if _, err := file.Write(payload); err != nil {
		_ = file.Close()
		_ = os.Remove(temp)
		return fmt.Errorf("写入 CodeBuddy 投影临时文件失败: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temp)
		return fmt.Errorf("同步 CodeBuddy 投影临时文件失败: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("关闭 CodeBuddy 投影临时文件失败: %w", err)
	}
	if err := os.Rename(temp, target); err != nil {
		_ = os.Remove(temp)
		return fmt.Errorf("替换 CodeBuddy 投影失败: %w", err)
	}
	return nil
}

// resolveWriteTarget 解析符号链接，避免用 rename 把链接替换成普通文件。
func resolveWriteTarget(path string) string {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return path
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	if link, err := os.Readlink(path); err == nil {
		if filepath.IsAbs(link) {
			return link
		}
		return filepath.Join(filepath.Dir(path), link)
	}
	return path
}

func sha256Hex(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func cachedDefaultModel(path string) string {
	payload, err := readFileOrEmpty(path)
	if err != nil || len(payload) == 0 {
		return ""
	}
	_, models, err := parseDocument(payload)
	if err != nil {
		return ""
	}
	managed := make([]map[string]any, 0, len(models))
	for _, entry := range models {
		if isManagedEntry(entry) {
			managed = append(managed, entry)
		}
	}
	return PreferredDefaultModel(managed)
}
