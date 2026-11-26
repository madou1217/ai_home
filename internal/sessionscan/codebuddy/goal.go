package codebuddy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// GoalState 是 CodeBuddy 会话最近一次 /goal 状态。
type GoalState struct {
	Active    bool
	Condition string
	UpdatedAt int64
}

type goalEvent struct {
	Type      string `json:"type"`
	Timestamp int64  `json:"timestamp"`
	Condition string `json:"condition"`
	OK        *bool  `json:"ok"`
	Provider  struct {
		GoalStatus *struct {
			Kind      string `json:"kind"`
			Condition string `json:"condition"`
		} `json:"goalStatus"`
	} `json:"providerData"`
}

// ReadSessionGoal 读取指定会话 JSONL 中最近一次 /goal 状态。
// 第二个返回值表示是否找到过任何 goal 事件；完成/清除后的 Active=false。
func ReadSessionGoal(hostHome, providerID, sessionID string) (GoalState, bool) {
	filePath, ok := SessionFilePath(hostHome, providerID, sessionID)
	if !ok {
		return GoalState{}, false
	}
	return readGoalFile(filePath)
}

// SessionFilePath 在家族会话根中定位 <sessionID>.jsonl。
func SessionFilePath(hostHome, providerID, sessionID string) (string, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || strings.ContainsAny(sessionID, "/\\..") {
		return "", false
	}
	for _, root := range projectsRoots(hostHome, providerID) {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			candidate := filepath.Join(root, entry.Name(), sessionID+".jsonl")
			if info, statErr := os.Stat(candidate); statErr == nil && info.Mode().IsRegular() {
				return candidate, true
			}
		}
	}
	return "", false
}

// LatestSession 返回当前目录最近更新的家族会话及其 JSONL 路径。
func LatestSession(hostHome, providerID, cwd string, budget Budget) (Session, string, bool) {
	if budget == nil {
		budget = unlimitedBudget{}
	}
	cwd = filepath.Clean(strings.TrimSpace(cwd))
	projects := ReadProjects(hostHome, providerID, budget)
	var latest Session
	found := false
	for _, project := range projects {
		if filepath.Clean(project.Path) != cwd {
			continue
		}
		for _, session := range project.Sessions {
			if !found || session.UpdatedAt > latest.UpdatedAt {
				latest = session
				found = true
			}
		}
	}
	if !found {
		return Session{}, "", false
	}
	filePath, ok := SessionFilePath(hostHome, providerID, latest.ID)
	if !ok {
		return Session{}, "", false
	}
	return latest, filePath, true
}

func readGoalFile(filePath string) (GoalState, bool) {
	file, err := os.Open(filePath)
	if err != nil {
		return GoalState{}, false
	}
	defer file.Close()
	state := GoalState{}
	found := false
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64<<10), 32<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var event goalEvent
		if json.Unmarshal(line, &event) != nil {
			continue
		}
		changed, active, condition := applyGoalEvent(event)
		if !changed {
			continue
		}
		found = true
		state.Active = active
		if condition != "" {
			state.Condition = condition
		}
		if event.Timestamp > 0 {
			state.UpdatedAt = event.Timestamp
		}
	}
	return state, found
}

func applyGoalEvent(event goalEvent) (bool, bool, string) {
	if event.Provider.GoalStatus != nil {
		status := event.Provider.GoalStatus
		switch strings.ToLower(strings.TrimSpace(status.Kind)) {
		case "set", "updated":
			return true, true, status.Condition
		case "cleared", "clear", "completed":
			return true, false, status.Condition
		}
	}
	switch strings.ToLower(strings.TrimSpace(event.Type)) {
	case "goal-progress":
		return true, true, event.Condition
	case "goal-result":
		if event.OK != nil && *event.OK {
			return true, false, event.Condition
		}
		return true, true, event.Condition
	}
	return false, false, ""
}

type unlimitedBudget struct{}

func (unlimitedBudget) Take() bool      { return true }
func (unlimitedBudget) OutOfTime() bool { return false }
