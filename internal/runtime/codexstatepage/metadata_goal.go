package codexstatepage

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Goal matches the native app-server wire, not the host workflow's Goal object.
// These are vendor read-only facts: no state transition or token update occurs.
type Goal struct {
	ThreadID        string `json:"threadId"`
	Objective       string `json:"objective"`
	Status          string `json:"status"`
	TokenBudget     *int64 `json:"tokenBudget"`
	TokensUsed      int64  `json:"tokensUsed"`
	TimeUsedSeconds int64  `json:"timeUsedSeconds"`
	CreatedAt       int64  `json:"createdAt"`
	UpdatedAt       int64  `json:"updatedAt"`
}

type GoalRead struct {
	State string `json:"state"`
	Goal  *Goal  `json:"goal"`
}

func normalizeGoalStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "active", "paused", "blocked", "complete":
		return strings.TrimSpace(status)
	case "budget_limited", "budgetLimited":
		return "budgetLimited"
	case "usage_limited", "usageLimited":
		return "usageLimited"
	default:
		return ""
	}
}

// ReadGoal distinguishes authoritative absence from unsupported storage/error.
// Only an existing valid vendor schema can establish an absent goal.
func ReadGoal(ctx context.Context, home, id string) (GoalRead, error) {
	home = strings.TrimSpace(home)
	id = strings.TrimSpace(id)
	if home == "" || !filepath.IsAbs(home) || id == "" {
		return GoalRead{}, errors.New("codex_metadata_input_invalid")
	}
	if len(id) > 4096 {
		return GoalRead{}, ErrBudget
	}
	db, tx, err := openVendorReadOnly(ctx, filepath.Join(home, "goals_1.sqlite"))
	if errors.Is(err, os.ErrNotExist) {
		return GoalRead{State: "unavailable"}, nil
	}
	if err != nil {
		return GoalRead{}, err
	}
	defer db.Close()
	defer tx.Rollback()
	columns, err := tableColumns(ctx, tx, "thread_goals")
	if err != nil {
		return GoalRead{}, err
	}
	for _, column := range []string{"thread_id", "objective", "status", "token_budget", "tokens_used", "time_used_seconds", "created_at_ms", "updated_at_ms"} {
		if !columns[column] {
			return GoalRead{State: "unsupported"}, nil
		}
	}
	var goal Goal
	var objective, status sql.NullString
	var budget, used, seconds, created, updated sql.NullInt64
	err = tx.QueryRowContext(ctx, `SELECT thread_id,objective,status,token_budget,tokens_used,time_used_seconds,created_at_ms,updated_at_ms FROM thread_goals WHERE thread_id=?`, id).Scan(&goal.ThreadID, &objective, &status, &budget, &used, &seconds, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return GoalRead{State: "absent"}, nil
	}
	if err != nil {
		return GoalRead{}, err
	}
	if len(objective.String) > maxMetadataBytes {
		return GoalRead{}, ErrBudget
	}
	goal.Objective = objective.String
	goal.Status = normalizeGoalStatus(status.String)
	if goal.Status == "" {
		return GoalRead{State: "unsupported"}, nil
	}
	if budget.Valid {
		value := budget.Int64
		goal.TokenBudget = &value
	}
	goal.TokensUsed = used.Int64
	goal.TimeUsedSeconds = seconds.Int64
	if created.Int64 > 0 {
		goal.CreatedAt = created.Int64 / 1000
	}
	if updated.Int64 > 0 {
		goal.UpdatedAt = updated.Int64 / 1000
	}
	return GoalRead{State: "found", Goal: &goal}, nil
}
