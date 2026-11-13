package webuiaccountimportapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// 作业状态取值与前端 AccountImportJob 的联合类型一致。
const (
	jobStatusQueued    = "queued"
	jobStatusRunning   = "running"
	jobStatusSucceeded = "succeeded"
	jobStatusFailed    = "failed"
)

const (
	// jobRetention 与 Node 的 ACCOUNT_IMPORT_JOB_RETENTION_MS 一致：终态作业保留 30 分钟。
	jobRetention = 30 * time.Minute
	// jobLimit 与 Node 的 ACCOUNT_IMPORT_JOB_MAX 一致。
	jobLimit = 50
	// progressEventMinInterval 与 Node 的 ACCOUNT_IMPORT_PROGRESS_EVENT_MIN_MS 一致：
	// 进度事件最多每 250ms 一条，完成帧不受限制。
	progressEventMinInterval = 250 * time.Millisecond
	// maxJobLogRunes 与 Node 的 20000 字符日志上限一致（按字符而不是字节截断）。
	maxJobLogRunes = 20000
)

// importSummary 是导入汇总；字段与前端 AccountImportSummary 一一对应。
//
// Providers / Accounts 必须序列化成数组而不是 null：页面直接对它们做 length/遍历。
type importSummary struct {
	Imported  int                    `json:"imported"`
	Created   int                    `json:"created"`
	Updated   int                    `json:"updated"`
	Skipped   int                    `json:"skipped"`
	Invalid   int                    `json:"invalid"`
	Failed    int                    `json:"failed"`
	Total     int                    `json:"total"`
	Providers []string               `json:"providers"`
	Accounts  []importSummaryAccount `json:"accounts"`
}

// importSummaryAccount 是成功写入的账号（只有 created / updated 会出现在这里）。
type importSummaryAccount struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Status     string `json:"status"`
}

// importProgress 是作业进度；percent 由 current/total 取整得出。
type importProgress struct {
	Current int    `json:"current"`
	Total   int    `json:"total"`
	Percent int    `json:"percent"`
	Label   string `json:"label"`
}

// importResult 是逐来源的导入结果。
type importResult struct {
	SourceResults []map[string]any `json:"sourceResults"`
}

// importJobView 是作业的公开快照；字段与前端 AccountImportJob 一致。
type importJobView struct {
	ID         string          `json:"id"`
	Status     string          `json:"status"`
	Mode       string          `json:"mode"`
	CreatedAt  int64           `json:"createdAt"`
	UpdatedAt  int64           `json:"updatedAt"`
	FinishedAt *int64          `json:"finishedAt"`
	Summary    importSummary   `json:"summary"`
	Result     *importResult   `json:"result"`
	Error      string          `json:"error"`
	Logs       string          `json:"logs"`
	Progress   *importProgress `json:"progress"`
}

// importJobEvent 是账号页 SSE 上的作业事件帧。
type importJobEvent struct {
	Type string        `json:"type"`
	Job  importJobView `json:"job"`
}

// importJob 是内存里的作业状态；所有读写都由 jobEngine.mu 保护。
type importJob struct {
	view                importJobView
	lastProgressEventAt time.Time
}

// jobEngine 是账号导入作业的唯一状态机。
//
// 只存在于 Go 进程内：作业跨请求存活（请求返回 202 后继续执行），进程重启即丢失，
// 与 Node 旧实现的语义一致——导入是短时动作，不落库。
type jobEngine struct {
	mu       sync.Mutex
	jobs     map[string]*importJob
	importer DocumentImporter
	publish  func(payload any)
	now      func() time.Time
}

func newJobEngine(
	importer DocumentImporter,
	publish func(payload any),
	now func() time.Time,
) *jobEngine {
	if now == nil {
		now = time.Now
	}
	return &jobEngine{
		jobs:     map[string]*importJob{},
		importer: importer,
		publish:  publish,
		now:      now,
	}
}

// start 创建并启动一个导入作业；已有活动作业时返回它的快照。
func (engine *jobEngine) start(payload importPayload) (importJobView, *importJobView) {
	now := engine.now()
	engine.mu.Lock()
	engine.pruneLocked(now)
	if active := engine.activeLocked(); active != nil {
		view := active.view
		engine.mu.Unlock()
		return importJobView{}, &view
	}
	job := &importJob{view: importJobView{
		ID:        newImportJobID(),
		Status:    jobStatusQueued,
		Mode:      payload.mode(),
		CreatedAt: now.UnixMilli(),
		UpdatedAt: now.UnixMilli(),
		Summary:   newImportSummary(),
	}}
	engine.jobs[job.view.ID] = job
	view := job.view
	engine.mu.Unlock()

	// 先广播 queued 帧再启动执行：页面拿到 202 时订阅里已经有这个作业。
	engine.emit(view)
	go engine.execute(job, payload)
	return view, nil
}

// get 返回作业快照；顺带清理过期作业，避免长期运行的进程只增不减。
func (engine *jobEngine) get(jobID string) (importJobView, bool) {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	engine.pruneLocked(engine.now())
	job, ok := engine.jobs[jobID]
	if !ok {
		return importJobView{}, false
	}
	return job.view, true
}

// execute 是作业主体：解析每个来源、逐条导入、汇总并广播终态。
func (engine *jobEngine) execute(job *importJob, payload importPayload) {
	defer func() {
		if recovered := recover(); recovered != nil {
			engine.fail(job, "import_failed")
		}
	}()
	engine.mutate(job, func(view *importJobView) {
		view.Status = jobStatusRunning
		view.UpdatedAt = engine.now().UnixMilli()
	})
	engine.appendLog(job, "导入任务已开始。")
	engine.emit(engine.snapshot(job))

	documents := payload.collectDocuments()
	if len(documents) == 0 {
		engine.fail(job, importErrorMissingContent)
		return
	}
	summary := newImportSummary()
	sourceResults := make([]map[string]any, 0, len(documents))
	for index, document := range documents {
		engine.setProgress(job, index, len(documents), document.Name)
		entries, code := parseImportDocument(document.Content)
		if code == "" && len(entries) == 0 {
			code = importErrorEmptyDocument
		}
		if code != "" {
			summary.Failed++
			sourceResults = append(sourceResults, map[string]any{
				"source": document.Name,
				"error":  code,
			})
			engine.appendLog(job, document.Name+": "+describeImportError(code))
			continue
		}
		result := engine.importer.ImportAihAccounts(context.Background(), entries)
		mergeImportSummary(&summary, result)
		sourceResults = append(sourceResults, sourceResult(document.Name, result.Summary))
		for _, outcome := range result.Accounts {
			if outcome.Status != "failed" && outcome.Status != "unsupported" {
				continue
			}
			engine.appendLog(job, fmt.Sprintf(
				"%s: %s %s %s (%s)",
				document.Name, outcome.Provider, outcome.AccountRef, outcome.Status, outcome.Reason,
			))
		}
	}
	engine.setProgress(job, len(documents), len(documents), "done")

	now := engine.now()
	engine.mutate(job, func(view *importJobView) {
		view.Status = jobStatusSucceeded
		view.Summary = summary
		view.Result = &importResult{SourceResults: sourceResults}
		view.FinishedAt = int64Pointer(now.UnixMilli())
		view.UpdatedAt = now.UnixMilli()
	})
	engine.appendLog(job, fmt.Sprintf(
		"导入完成：写入 %d，失败 %d。", summary.Imported, summary.Failed+summary.Invalid,
	))
	engine.emit(engine.snapshot(job))
}

// fail 把作业置为失败终态；error 是稳定码，不含凭据内容。
func (engine *jobEngine) fail(job *importJob, reason string) {
	now := engine.now()
	engine.mutate(job, func(view *importJobView) {
		view.Status = jobStatusFailed
		view.Error = reason
		view.FinishedAt = int64Pointer(now.UnixMilli())
		view.UpdatedAt = now.UnixMilli()
	})
	engine.appendLog(job, "导入失败："+reason)
	engine.emit(engine.snapshot(job))
}

// setProgress 更新进度并按 250ms 节流广播；完成帧总是广播。
func (engine *jobEngine) setProgress(job *importJob, current, total int, label string) {
	if total < 1 {
		total = 1
	}
	if current < 0 {
		current = 0
	}
	if current > total {
		current = total
	}
	now := engine.now()
	complete := current >= total
	engine.mu.Lock()
	job.view.Progress = &importProgress{
		Current: current,
		Total:   total,
		Percent: (current*100 + total/2) / total,
		Label:   label,
	}
	job.view.UpdatedAt = now.UnixMilli()
	emit := complete || now.Sub(job.lastProgressEventAt) >= progressEventMinInterval
	if emit {
		job.lastProgressEventAt = now
	}
	view := job.view
	engine.mu.Unlock()
	if emit {
		engine.emit(view)
	}
}

// mutate 在锁内修改作业视图并返回快照。
func (engine *jobEngine) mutate(job *importJob, apply func(*importJobView)) {
	engine.mu.Lock()
	apply(&job.view)
	engine.mu.Unlock()
}

// snapshot 读取作业视图的副本；Progress / Result 只在写入时整体替换，读侧不需要深拷贝。
func (engine *jobEngine) snapshot(job *importJob) importJobView {
	engine.mu.Lock()
	defer engine.mu.Unlock()
	return job.view
}

// appendLog 追加一行日志，按字符截断到 20000。
func (engine *jobEngine) appendLog(job *importJob, line string) {
	text := line
	if text == "" {
		return
	}
	engine.mu.Lock()
	next := job.view.Logs + text + "\n"
	if runes := []rune(next); len(runes) > maxJobLogRunes {
		next = string(runes[len(runes)-maxJobLogRunes:])
	}
	job.view.Logs = next
	job.view.UpdatedAt = engine.now().UnixMilli()
	engine.mu.Unlock()
}

// emit 把作业快照广播到账号页事件流。
func (engine *jobEngine) emit(view importJobView) {
	if engine.publish == nil {
		return
	}
	engine.publish(importJobEvent{Type: "import-job", Job: view})
}

// pruneLocked 清理过期终态作业，并把总数压到上限以内。
func (engine *jobEngine) pruneLocked(now time.Time) {
	for id, job := range engine.jobs {
		if isActiveJob(job.view.Status) {
			continue
		}
		finishedAt := job.view.CreatedAt
		if job.view.FinishedAt != nil {
			finishedAt = *job.view.FinishedAt
		} else if job.view.UpdatedAt > 0 {
			finishedAt = job.view.UpdatedAt
		}
		if finishedAt > 0 && now.Sub(time.UnixMilli(finishedAt)) > jobRetention {
			delete(engine.jobs, id)
		}
	}
	if len(engine.jobs) <= jobLimit {
		return
	}
	removable := make([]*importJob, 0, len(engine.jobs))
	for _, job := range engine.jobs {
		if isActiveJob(job.view.Status) {
			continue
		}
		removable = append(removable, job)
	}
	sort.Slice(removable, func(left, right int) bool {
		return removable[left].view.UpdatedAt < removable[right].view.UpdatedAt
	})
	for _, job := range removable {
		if len(engine.jobs) <= jobLimit {
			break
		}
		delete(engine.jobs, job.view.ID)
	}
}

// activeLocked 返回当前活动作业；同一时刻最多一个。
func (engine *jobEngine) activeLocked() *importJob {
	for _, job := range engine.jobs {
		if isActiveJob(job.view.Status) {
			return job
		}
	}
	return nil
}

func isActiveJob(status string) bool {
	return status == jobStatusQueued || status == jobStatusRunning
}

func newImportSummary() importSummary {
	return importSummary{Providers: []string{}, Accounts: []importSummaryAccount{}}
}

// mergeImportSummary 合并一份文档的导入结果；imported 始终由 created+updated 派生。
func mergeImportSummary(summary *importSummary, result accountsapi.AihAccountsImportResult) {
	summary.Total += result.Summary["total"]
	summary.Created += result.Summary["created"]
	summary.Updated += result.Summary["updated"]
	summary.Skipped += result.Summary["skipped"]
	summary.Failed += result.Summary["failed"]
	summary.Imported = summary.Created + summary.Updated
	for _, outcome := range result.Accounts {
		if outcome.Status != "created" && outcome.Status != "updated" {
			continue
		}
		summary.Accounts = append(summary.Accounts, importSummaryAccount{
			Provider:   outcome.Provider,
			AccountRef: outcome.AccountRef,
			Status:     outcome.Status,
		})
		addImportedProvider(summary, outcome.Provider)
	}
}

// addImportedProvider 维护去重且有序的 providers 列表。
func addImportedProvider(summary *importSummary, provider string) {
	if provider == "" {
		return
	}
	for _, existing := range summary.Providers {
		if existing == provider {
			return
		}
	}
	summary.Providers = append(summary.Providers, provider)
	sort.Strings(summary.Providers)
}

// sourceResult 把 Go 的 summary 摊平到逐来源结果里（键与原实现一致）。
func sourceResult(source string, summary map[string]int) map[string]any {
	return map[string]any{
		"source":  source,
		"total":   summary["total"],
		"created": summary["created"],
		"updated": summary["updated"],
		"skipped": summary["skipped"],
		"failed":  summary["failed"],
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}

// newImportJobID 生成 UUIDv4 形态的作业 id（与 Node 的 crypto.randomUUID 同形）。
func newImportJobID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// 随机源不可用时宁可失败，也不要让两个作业撞同一个 id。
		return fmt.Sprintf("import-%d", time.Now().UnixNano())
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" +
		encoded[16:20] + "-" + encoded[20:32]
}
