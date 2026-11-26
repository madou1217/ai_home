// Package launchselection 为"不带账号编号的裸启动"挑选账号。
//
// 借用 relay 的调度口径：健康优先、余量优先、最少最近使用（fair round robin）。
// 与 relay 的区别是执行体：relay 在服务进程内存里轮转，这里由 CLI 进程挑号，
// 所以"最近使用"要落到共享文件并加锁，否则并发启动会同时命中同一个账号。
package launchselection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/accountadmission"
)

// recentWindowMillis 是"刚被选过就让开"的时间窗。
const recentWindowMillis = int64(90 * 1000)

// ErrNoHealthyAccount 表示所有候选都处于账号/模型 429、额度耗尽或不可调度。
// 调用方必须失败关闭，不能把新会话落到已知受限的账号上。
var ErrNoHealthyAccount = errors.New("launchselection: no healthy account")

// Candidate 是管理面返回的账号候选。
type Candidate struct {
	AccountRef   string   `json:"accountRef"`
	DisplayID    string   `json:"displayId"`
	Enabled      bool     `json:"enabled"`
	Configured   bool     `json:"configured"`
	Status       string   `json:"status"`
	RemainingPct *float64 `json:"remainingPct"`
	// SchedulableStatus / QuotaStatus 是账号页同源的可调度事实。
	// 管理面里 Status 只有 up/down（启停），不能当健康度：把 up 当成病态会让
	// 「健康优先」永远失效，只能退化成余量/最近使用排序。
	SchedulableStatus string `json:"schedulableStatus"`
	QuotaStatus       string `json:"quotaStatus"`
	// RuntimeModels 是账号页同源的模型级阻塞/冷却；账号级 429 之外，
	// CodeBuddy 的 429 往往只落在具体模型上，不能只看账号级 schedulable。
	RuntimeModels []RuntimeModel `json:"runtimeModels"`
}

// RuntimeModel 是账号在某一个模型上的冷却/阻塞事实。
type RuntimeModel struct {
	Model         string            `json:"model"`
	CooldownUntil int64             `json:"cooldownUntil"`
	Blocks        []json.RawMessage `json:"blocks"`
}

// Options 描述一次选号请求。
type Options struct {
	AIHomeDir     string
	BaseURL       string
	ManagementKey string
	Provider      string
	// Model 是本次要启动的模型；为空时保守地把任何模型级冷却都视为不健康。
	Model      string
	HTTPClient *http.Client
	Now        func() time.Time
}

// Pick 返回当前最该用的账号；没有可用候选时 found=false。
func Pick(ctx context.Context, options Options) (Candidate, bool, error) {
	candidates, err := fetchCandidates(ctx, options)
	if err != nil {
		return Candidate{}, false, err
	}
	usable := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		if !candidate.Enabled || !candidate.Configured || strings.TrimSpace(candidate.DisplayID) == "" {
			continue
		}
		// status 非空代表限流/故障等运行态；健康优先，但不直接丢弃：全部不健康时仍要能启动。
		usable = append(usable, candidate)
	}
	if len(usable) == 0 {
		return Candidate{}, false, nil
	}
	nowFunc := time.Now
	if options.Now != nil {
		nowFunc = options.Now
	}
	usage, lock, lockErr := lockUsage(options.AIHomeDir)
	if lockErr == nil && lock != nil {
		defer releaseUsage(lock)
	}
	current := nowFunc()
	nowMS := current.UnixMilli()
	// 账号启动租约能识别「这个账号已有一个 Native CLI 会话」：
	// 1/2/3 已开着时优先选空闲账号，不要把新会话继续压到它们身上。
	active := make(map[string]bool, len(usable))
	for _, candidate := range usable {
		active[candidate.AccountRef] = accountadmission.Active(
			options.AIHomeDir,
			options.Provider,
			candidate.AccountRef,
		)
	}
	// 健康候选优先；如果全部账号都 429/额度耗尽，才退回不健康候选。
	// 不能用「最近使用池」把健康候选挡在外面：否则刚启动过健康账号后，
	// 唯一未使用的账号即使模型 429 也会被选中。
	healthy := make([]Candidate, 0, len(usable))
	for _, candidate := range usable {
		if isHealthy(candidate, options.Model, nowMS) {
			healthy = append(healthy, candidate)
		}
	}
	if len(healthy) == 0 {
		return Candidate{}, false, ErrNoHealthyAccount
	}
	pool := healthy
	sort.SliceStable(pool, func(left, right int) bool {
		a, b := pool[left], pool[right]
		if active[a.AccountRef] != active[b.AccountRef] {
			return !active[a.AccountRef]
		}
		aRecent := nowMS-usage.lastUsed(a.AccountRef) < recentWindowMillis
		bRecent := nowMS-usage.lastUsed(b.AccountRef) < recentWindowMillis
		if aRecent != bRecent {
			return !aRecent
		}
		if remaining(a) != remaining(b) {
			return remaining(a) > remaining(b)
		}
		aUsed, bUsed := usage.lastUsed(a.AccountRef), usage.lastUsed(b.AccountRef)
		if aUsed != bUsed {
			return aUsed < bUsed
		}
		return a.DisplayID < b.DisplayID
	})
	chosen := pool[0]
	if lockErr == nil && usage != nil {
		usage.record(chosen.AccountRef, current)
		_ = saveUsage(options.AIHomeDir, usage)
	}
	return chosen, true, nil
}

// isHealthy 判定裸启动口径的「健康」：启用、未被调度阻塞、额度未耗尽。
//
// Status 是启停事实（up/down），永远非空；用它判健康会让所有账号都被当成不健康，
// 健康优先形同虚设。真正的运行/额度阻塞由 schedulableStatus 与 quotaStatus 表达，
// 缺字段（旧服务端）时按健康处理，保持与历史选号一致的降级。
func isHealthy(candidate Candidate, model string, nowMS int64) bool {
	if strings.EqualFold(strings.TrimSpace(candidate.Status), "down") {
		return false
	}
	schedulable := strings.TrimSpace(candidate.SchedulableStatus)
	if schedulable != "" && !strings.EqualFold(schedulable, "schedulable") {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(candidate.QuotaStatus), "exhausted") {
		return false
	}
	return !blockedByModel(candidate, model, nowMS)
}

// blockedByModel 检查账号-模型级 429/阻塞。
//
// 未显式指定模型时保守处理：只要账号上还有任意未过期的模型冷却，
// 就不把它当作健康候选，避免裸启动命中「这个账号只是这个模型 429」。
func blockedByModel(candidate Candidate, model string, nowMS int64) bool {
	model = strings.TrimSpace(model)
	for _, item := range candidate.RuntimeModels {
		until := item.CooldownUntil
		if until > 0 && until <= nowMS && len(item.Blocks) == 0 {
			continue
		}
		if len(item.Blocks) > 0 {
			if model == "" || strings.EqualFold(strings.TrimSpace(item.Model), model) {
				return true
			}
			continue
		}
		if until <= nowMS {
			continue
		}
		if model == "" || strings.EqualFold(strings.TrimSpace(item.Model), model) {
			return true
		}
	}
	return false
}

func remaining(candidate Candidate) float64 {
	if candidate.RemainingPct == nil {
		return -1
	}
	return *candidate.RemainingPct
}

func fetchCandidates(ctx context.Context, options Options) ([]Candidate, error) {
	baseURL := strings.TrimSpace(options.BaseURL)
	key := strings.TrimSpace(options.ManagementKey)
	if baseURL == "" || key == "" || strings.TrimSpace(options.Provider) == "" {
		return nil, fmt.Errorf("launchselection: 缺少 server 地址、管理密钥或 provider")
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 4 * time.Second}
	}
	endpoint := strings.TrimSuffix(baseURL, "/") + "/v1/management/webui/accounts?provider=" + url.QueryEscape(options.Provider)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("launchselection: accounts http %d", response.StatusCode)
	}
	var payload struct {
		Accounts []Candidate `json:"accounts"`
	}
	if err = json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}
	return payload.Accounts, nil
}

// usageState 记录每个账号最近一次被裸启动选中的时间。
type usageState struct {
	LastUsed map[string]int64 `json:"lastUsed"`
}

func (state *usageState) lastUsed(ref string) int64 {
	if state == nil || state.LastUsed == nil {
		return 0
	}
	return state.LastUsed[ref]
}

func (state *usageState) record(ref string, at time.Time) {
	if state.LastUsed == nil {
		state.LastUsed = map[string]int64{}
	}
	state.LastUsed[ref] = at.UnixMilli()
	// 只保留最近 200 条，避免文件无限增长。
	if len(state.LastUsed) > 200 {
		oldest, oldestRef := int64(0), ""
		for key, value := range state.LastUsed {
			if oldest == 0 || value < oldest {
				oldest, oldestRef = value, key
			}
		}
		delete(state.LastUsed, oldestRef)
	}
}

func usagePath(aiHomeDir string) string {
	return filepath.Join(aiHomeDir, "run", "launch-selection.json")
}

func parseUsage(raw []byte) *usageState {
	state := &usageState{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, state)
	}
	return state
}

func saveUsage(aiHomeDir string, state *usageState) error {
	path := usagePath(aiHomeDir)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temp := path + ".tmp" + strconv.Itoa(os.Getpid())
	if err = os.WriteFile(temp, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}
