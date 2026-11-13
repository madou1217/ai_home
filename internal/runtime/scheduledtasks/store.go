package scheduledtasks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// StateVersion 是 state.json 格式版本号。
	StateVersion = 1
	// DefaultRecordRetentionDays 是运行记录默认保留天数。
	DefaultRecordRetentionDays = 7
	// MaxRecords 是单份状态最多保留的运行记录数。
	MaxRecords = 800
	// MaxTasks 是最多允许定义的计划任务数。
	MaxTasks = 200
)

// Task 是持久化在 state.json 里的计划任务定义与运行态字段。
type Task struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	EventID     string         `json:"eventId"`
	EventLabel  string         `json:"eventLabel,omitempty"`
	EventParams map[string]any `json:"eventParams"`
	Schedule    *Schedule      `json:"schedule"`
	Enabled     bool           `json:"enabled"`
	CreatedAt   int64          `json:"createdAt"`
	UpdatedAt   int64          `json:"updatedAt"`
	LastRunAt   int64          `json:"lastRunAt"`
	LastStatus  string         `json:"lastStatus"`
	LastSummary string         `json:"lastSummary"`
	NextRunAt   int64          `json:"nextRunAt"`
	Running     bool           `json:"running"`
}

// TaskView 是返回给 WebUI 的计划任务投影。
type TaskView struct {
	ID            string         `json:"id"`
	Name          string         `json:"name"`
	EventID       string         `json:"eventId"`
	EventLabel    string         `json:"eventLabel"`
	EventParams   map[string]any `json:"eventParams"`
	Schedule      *Schedule      `json:"schedule"`
	ScheduleLabel string         `json:"scheduleLabel"`
	Enabled       bool           `json:"enabled"`
	CreatedAt     int64          `json:"createdAt"`
	UpdatedAt     int64          `json:"updatedAt"`
	LastRunAt     int64          `json:"lastRunAt"`
	LastStatus    string         `json:"lastStatus"`
	LastSummary   string         `json:"lastSummary"`
	NextRunAt     int64          `json:"nextRunAt"`
	Running       bool           `json:"running"`
}

// Record 是单次执行的运行记录。
type Record struct {
	ID           string `json:"id"`
	TaskID       string `json:"taskId"`
	TaskName     string `json:"taskName"`
	EventID      string `json:"eventId"`
	EventLabel   string `json:"eventLabel"`
	Trigger      string `json:"trigger"`
	Status       string `json:"status"`
	Summary      string `json:"summary"`
	Error        string `json:"error"`
	ErrorSummary string `json:"errorSummary"`
	StartedAt    int64  `json:"startedAt"`
	FinishedAt   int64  `json:"finishedAt"`
	JobID        string `json:"jobId,omitempty"`
}

// State 是 <aiHomeDir>/run/scheduled-tasks/state.json 的磁盘格式。
type State struct {
	Version int      `json:"version"`
	Tasks   []Task   `json:"tasks"`
	Records []Record `json:"records"`
}

// SerializeTask 把内部 Task 投影成 HTTP/WebUI 视图。
func SerializeTask(task Task) TaskView {
	label := task.EventLabel
	if label == "" {
		label = task.EventID
	}
	params := task.EventParams
	if params == nil {
		params = map[string]any{}
	}
	return TaskView{
		ID:            task.ID,
		Name:          task.Name,
		EventID:       task.EventID,
		EventLabel:    label,
		EventParams:   params,
		Schedule:      task.Schedule,
		ScheduleLabel: ScheduleLabel(task.Schedule),
		Enabled:       task.Enabled,
		CreatedAt:     task.CreatedAt,
		UpdatedAt:     task.UpdatedAt,
		LastRunAt:     task.LastRunAt,
		LastStatus:    strings.TrimSpace(task.LastStatus),
		LastSummary:   strings.TrimSpace(task.LastSummary),
		NextRunAt:     task.NextRunAt,
		Running:       task.Running,
	}
}

func resolveStatePath(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), "run", "scheduled-tasks", "state.json")
}

func emptyState() State {
	return State{
		Version: StateVersion,
		Tasks:   []Task{},
		Records: []Record{},
	}
}

// PruneState 按保留天数与条数上限裁剪状态副本。
func PruneState(state State, nowMS int64, retentionDays int) State {
	if retentionDays < 1 {
		retentionDays = DefaultRecordRetentionDays
	}
	cutoff := nowMS - int64(retentionDays)*24*60*60*1000
	kept := make([]Record, 0, len(state.Records))
	for _, row := range state.Records {
		ts := row.FinishedAt
		if ts == 0 {
			ts = row.StartedAt
		}
		if ts >= cutoff {
			kept = append(kept, row)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool {
		return kept[i].StartedAt > kept[j].StartedAt
	})
	if len(kept) > MaxRecords {
		kept = kept[:MaxRecords]
	}
	tasks := make([]Task, 0, len(state.Tasks))
	limit := len(state.Tasks)
	if limit > MaxTasks {
		limit = MaxTasks
	}
	for i := 0; i < limit; i++ {
		t := state.Tasks[i]
		if t.EventParams == nil {
			t.EventParams = map[string]any{}
		}
		tasks = append(tasks, t)
	}
	return State{
		Version: StateVersion,
		Tasks:   tasks,
		Records: kept,
	}
}

func readStateFile(aiHomeDir string, nowMS int64) State {
	file := resolveStatePath(aiHomeDir)
	raw, err := os.ReadFile(file)
	if err != nil {
		return emptyState()
	}
	var parsed State
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return emptyState()
	}
	return PruneState(parsed, nowMS, DefaultRecordRetentionDays)
}

func writeStateFile(aiHomeDir string, state State, nowMS int64) (State, error) {
	file := resolveStatePath(aiHomeDir)
	dir := filepath.Dir(file)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return State{}, err
	}
	pruned := PruneState(state, nowMS, DefaultRecordRetentionDays)
	encoded, err := json.MarshalIndent(pruned, "", "  ")
	if err != nil {
		return State{}, err
	}
	encoded = append(encoded, '\n')
	temp := filepath.Join(dir, fmt.Sprintf("state.json.tmp-%d-%d", os.Getpid(), time.Now().UnixNano()))
	if err := os.WriteFile(temp, encoded, 0o600); err != nil {
		return State{}, err
	}
	if err := os.Rename(temp, file); err != nil {
		_ = os.Remove(temp)
		return State{}, err
	}
	_ = os.Chmod(file, 0o600)
	return pruned, nil
}
