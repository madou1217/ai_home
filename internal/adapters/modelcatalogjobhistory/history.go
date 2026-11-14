// Package modelcatalogjobhistory 把模型目录刷新的终态结果持久化到 app-state.db。
//
// 作业队列本身仍是进程内状态：queued/running 只在当前进程有意义，重启后不该复活。
// 这里只记录已经结束的作业（succeeded/failed），用于重启后展示「上次刷新结果」与
// 事后诊断。文档不包含 catalog 快照——模型目录的真值在 aih.db 的 account_models
// 与 account_model_probes，单次 catalog 可达数 MB，落盘会污染共享的 app-state.db。
package modelcatalogjobhistory

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// DatabaseKey 是 app_kv 中保存刷新历史的键。
	DatabaseKey = "model-catalog-refresh-history"
	// DocumentVersion 是当前持久化文档版本。
	DocumentVersion = 1
	// MaxRecords 是保留的终态作业上限；按完成时间保留最新的记录。
	MaxRecords = 200
	// maxErrorRunes 与 webuimodelsyncapi 的作业错误截断保持一致。
	maxErrorRunes = 240
)

const retention = 30 * 24 * time.Hour

// ErrInvalidStore 表示 Store 没有可用的 app-state 数据库路径。
var ErrInvalidStore = errors.New("模型刷新历史存储未配置")

// ErrInvalidJob 表示作业记录缺少 id 或不是终态。
var ErrInvalidJob = errors.New("模型刷新历史记录无效")

// Job 是一条终态刷新作业。Scope 为空串表示全局刷新，否则是 Go 的账号引用。
type Job struct {
	ID         string `json:"id"`
	Scope      string `json:"scope,omitempty"`
	Status     string `json:"status"`
	StartedAt  int64  `json:"startedAt"`
	FinishedAt int64  `json:"finishedAt"`
	Error      string `json:"error,omitempty"`
	ModelCount int    `json:"modelCount"`
	Sources    int    `json:"sources"`
}

type document struct {
	Version   int   `json:"version"`
	UpdatedAt int64 `json:"updatedAt"`
	Jobs      []Job `json:"jobs"`
}

// Store 读写 app-state.db 里的刷新历史文档。
type Store struct {
	databasePath string
}

// NewStore 用 app-state.db 路径创建 Store；空路径会在调用时报 ErrInvalidStore。
func NewStore(databasePath string) *Store {
	return &Store{databasePath: strings.TrimSpace(databasePath)}
}

// Record 写入一条终态作业。同一 id 幂等覆盖，随后按数量与时间裁剪。
func (store *Store) Record(ctx context.Context, job Job) error {
	if store == nil || store.databasePath == "" {
		return ErrInvalidStore
	}
	nowMS := time.Now().UnixMilli()
	normalized, ok := normalizeJob(job, nowMS)
	if !ok {
		return ErrInvalidJob
	}
	return appstate.UpdateKV(ctx, store.databasePath, DatabaseKey, func(current string, found bool) (string, error) {
		doc := normalizeDocument(current, nowMS)
		doc.Jobs = upsertJob(doc.Jobs, normalized)
		doc.Jobs = trimJobs(doc.Jobs, nowMS)
		doc.Version = DocumentVersion
		doc.UpdatedAt = nowMS
		body, err := json.Marshal(doc)
		if err != nil {
			return "", err
		}
		return string(body), nil
	})
}

// Recent 返回最近 limit 条终态作业，按完成时间倒序；limit<=0 时不截断。
func (store *Store) Recent(ctx context.Context, limit int) ([]Job, error) {
	if store == nil || store.databasePath == "" {
		return nil, ErrInvalidStore
	}
	raw, found, err := appstate.ReadKV(ctx, store.databasePath, DatabaseKey)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	doc := normalizeDocument(raw, time.Now().UnixMilli())
	if limit > 0 && len(doc.Jobs) > limit {
		doc.Jobs = doc.Jobs[:limit]
	}
	return doc.Jobs, nil
}

// normalizeDocument 对坏数据只丢弃坏记录，不因为单条损坏丢掉整份历史。
func normalizeDocument(raw string, nowMS int64) document {
	doc := document{Version: DocumentVersion}
	if strings.TrimSpace(raw) == "" {
		return doc
	}
	var envelope struct {
		Version   int               `json:"version"`
		UpdatedAt int64             `json:"updatedAt"`
		Jobs      []json.RawMessage `json:"jobs"`
	}
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		return doc
	}
	doc.UpdatedAt = envelope.UpdatedAt
	for _, item := range envelope.Jobs {
		var job Job
		if err := json.Unmarshal(item, &job); err != nil {
			continue
		}
		normalized, ok := normalizeJob(job, nowMS)
		if !ok {
			continue
		}
		doc.Jobs = upsertJob(doc.Jobs, normalized)
	}
	doc.Jobs = sortJobs(doc.Jobs)
	return doc
}

func normalizeJob(job Job, nowMS int64) (Job, bool) {
	job.ID = strings.TrimSpace(job.ID)
	if job.ID == "" {
		return Job{}, false
	}
	switch job.Status {
	case "succeeded", "failed":
	default:
		return Job{}, false
	}
	job.Scope = strings.TrimSpace(job.Scope)
	if job.Scope != "" {
		parsed, err := accountcore.ParseAccountRef(job.Scope)
		if err != nil {
			return Job{}, false
		}
		job.Scope = parsed.String()
	}
	if job.FinishedAt <= 0 {
		job.FinishedAt = nowMS
	}
	if job.StartedAt < 0 {
		job.StartedAt = 0
	}
	if job.ModelCount < 0 {
		job.ModelCount = 0
	}
	if job.Sources < 0 {
		job.Sources = 0
	}
	job.Error = truncateRunes(strings.TrimSpace(job.Error), maxErrorRunes)
	return job, true
}

func upsertJob(jobs []Job, job Job) []Job {
	next := make([]Job, 0, len(jobs)+1)
	replaced := false
	for _, existing := range jobs {
		if existing.ID == job.ID {
			if !replaced {
				next = append(next, job)
				replaced = true
			}
			continue
		}
		next = append(next, existing)
	}
	if !replaced {
		next = append(next, job)
	}
	return next
}

func trimJobs(jobs []Job, nowMS int64) []Job {
	cutoff := nowMS - retention.Milliseconds()
	sorted := sortJobs(jobs)
	next := make([]Job, 0, len(sorted))
	for _, job := range sorted {
		if job.FinishedAt > 0 && job.FinishedAt < cutoff {
			continue
		}
		if len(next) >= MaxRecords {
			break
		}
		next = append(next, job)
	}
	return next
}

func sortJobs(jobs []Job) []Job {
	sorted := make([]Job, len(jobs))
	copy(sorted, jobs)
	sort.SliceStable(sorted, func(left, right int) bool {
		if sorted[left].FinishedAt != sorted[right].FinishedAt {
			return sorted[left].FinishedAt > sorted[right].FinishedAt
		}
		return sorted[left].ID > sorted[right].ID
	})
	return sorted
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 || utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}
