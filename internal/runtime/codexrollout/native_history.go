package codexrollout

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	_ "modernc.org/sqlite"
)

// Codex 0.170 起新会话默认 history_mode=paginated：rollout 只留元数据，
// 消息项落在 .codex/thread_history_1.sqlite 的 thread_items 里。旧读取路径遇到
// 这种会话会整段放弃（eligible=false），所有展示层因此看不到任何消息。
// 这里直接读原生分页库，把 item_json 原样还原成 Turn。
var ErrNativeHistoryUnavailable = errors.New("codex_native_history_unavailable")

const nativeHistoryDatabase = "thread_history_1.sqlite"

// codexDirFromRollout 从 .../.codex/sessions/<date>/rollout-*.jsonl 反推 .codex 目录。
func codexDirFromRollout(rolloutPath string) string {
	dir := filepath.Dir(filepath.Clean(rolloutPath))
	for {
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		if filepath.Base(dir) == "sessions" {
			return parent
		}
		dir = parent
	}
}

// threadIDFromRollout 取文件名末尾的会话 ID：rollout-<时间>-<uuid>.jsonl。
func threadIDFromRollout(rolloutPath string) string {
	name := strings.TrimSuffix(filepath.Base(rolloutPath), filepath.Ext(rolloutPath))
	if len(name) < 36 {
		return ""
	}
	return name[len(name)-36:]
}

func readPaginatedTurns(ctx context.Context, rolloutPath string, options Options) (ReadResult, error) {
	// normalized() 会把空 ThreadID 填成哨兵值 "thread"，所以以文件名里的真实
	// 会话 ID 为准，取不到时才回退到调用方传入的 ID。
	threadID := threadIDFromRollout(rolloutPath)
	if threadID == "" {
		if candidate := strings.TrimSpace(options.ThreadID); candidate != "" && candidate != "thread" {
			threadID = candidate
		}
	}
	codexDir := codexDirFromRollout(rolloutPath)
	if threadID == "" || codexDir == "" {
		return ReadResult{Eligible: false, Reason: "native_paginated_history", Turns: []*Turn{}}, nil
	}
	databasePath := filepath.Join(codexDir, nativeHistoryDatabase)
	if info, err := os.Stat(databasePath); err != nil || !info.Mode().IsRegular() {
		return ReadResult{}, ErrNativeHistoryUnavailable
	}
	uri := sqlitefile.URL(databasePath)
	query := uri.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "query_only(1)")
	query.Add("_pragma", "busy_timeout(2000)")
	uri.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return ReadResult{}, ErrNativeHistoryUnavailable
	}
	defer database.Close()
	database.SetMaxOpenConns(1)
	statement := "SELECT turn_id, item_json, created_at_ms FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal"
	rows, err := database.QueryContext(ctx, statement, threadID)
	if err != nil {
		return ReadResult{}, ErrNativeHistoryUnavailable
	}
	defer rows.Close()
	turns := make([]*Turn, 0, 16)
	index := make(map[string]*Turn)
	for rows.Next() {
		var turnID, itemJSON string
		var createdAtMS sql.NullInt64
		if err := rows.Scan(&turnID, &itemJSON, &createdAtMS); err != nil {
			return ReadResult{}, ErrNativeHistoryUnavailable
		}
		item := map[string]any{}
		if json.Unmarshal([]byte(itemJSON), &item) != nil {
			continue
		}
		turn := index[turnID]
		if turn == nil {
			turn = &Turn{ID: turnID, Items: []map[string]any{}, ItemsView: "full", Status: "completed"}
			index[turnID] = turn
			turns = append(turns, turn)
		}
		if createdAtMS.Valid {
			at := float64(createdAtMS.Int64) / 1000
			if len(turn.Items) == 0 {
				turn.StartedAt = &at
			}
			turn.CompletedAt = &at
		}
		turn.Items = append(turn.Items, item)
	}
	if err := rows.Err(); err != nil {
		return ReadResult{}, ErrNativeHistoryUnavailable
	}
	sort.SliceStable(turns, func(i, j int) bool { return turnStart(turns[i]) < turnStart(turns[j]) })
	limit := options.TurnLimit
	if limit <= 0 || limit > defaultTurnLimit {
		limit = defaultTurnLimit
	}
	if len(turns) > limit {
		turns = turns[len(turns)-limit:]
	}
	return ReadResult{Eligible: true, Turns: turns}, nil
}

func turnStart(turn *Turn) float64 {
	if turn == nil || turn.StartedAt == nil {
		return 0
	}
	return *turn.StartedAt
}
