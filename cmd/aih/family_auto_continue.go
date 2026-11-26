package main

import (
	"os"
	"strings"
	"time"

	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
)

// familyAutoContinueMaxAge 限定自动续聊的会话新鲜度，避免打开很久以前的
// 无关会话。账号切换通常发生在几分钟内。
const familyAutoContinueMaxAge = 7 * 24 * time.Hour

type familySessionBudget struct{}

func (familySessionBudget) Take() bool      { return true }
func (familySessionBudget) OutOfTime() bool { return false }

// maybeAutoContinueFamilyLaunch 让 aih codebuddycn 2 这类只带账号、没有
// 其他参数的启动自动接上当前目录最近的会话。
//
// 用户显式传 --fresh / --new 时保持新建会话；显式 resume/continue、原生
// 旗标或提示词时不介入，避免改变已有语义。
func maybeAutoContinueFamilyLaunch(
	providerID string,
	arguments []string,
	runtime commandRuntime,
) []string {
	if !codebuddyfamilystorage.IsFamilyProvider(providerID) {
		return arguments
	}
	fresh := false
	filtered := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		switch strings.ToLower(strings.TrimSpace(argument)) {
		case "--fresh", "--new":
			fresh = true
		default:
			filtered = append(filtered, argument)
		}
	}
	if fresh {
		return filtered
	}
	if len(filtered) > 1 {
		return arguments
	}
	if len(filtered) == 1 && !isNumericAccountToken(filtered[0]) {
		return arguments
	}
	if containsAnySessionFlag(filtered) {
		return arguments
	}
	prompt, ok := familyLatestContinuationPrompt(providerID, runtime)
	if !ok {
		return arguments
	}
	return append(filtered, "--continue", prompt)
}

func sessionVerbHasExplicitPrompt(rest []string) bool {
	for _, argument := range rest {
		trimmed := strings.TrimSpace(argument)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "-") {
			return true
		}
	}
	return false
}

func containsAnySessionFlag(arguments []string) bool {
	for _, argument := range arguments {
		switch strings.ToLower(strings.TrimSpace(argument)) {
		case "--", "--continue", "-c", "--resume", "-r", "resume", "fork":
			return true
		}
	}
	return false
}

func familyLatestContinuationPrompt(
	providerID string,
	runtime commandRuntime,
) (string, bool) {
	hostHome, err := runtime.userHomeDir()
	if err != nil || strings.TrimSpace(hostHome) == "" {
		return "", false
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", false
	}
	session, _, ok := codebuddy.LatestSession(
		hostHome,
		providerID,
		cwd,
		familySessionBudget{},
	)
	if !ok {
		return "", false
	}
	if session.UpdatedAt > 0 && time.Since(time.UnixMilli(session.UpdatedAt)) > familyAutoContinueMaxAge {
		return "", false
	}
	return familyContinuationPrompt(hostHome, providerID, session.ID)
}

func familyContinuationPrompt(
	hostHome string,
	providerID string,
	sessionID string,
) (string, bool) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return "continue", false
	}
	goal, found := codebuddy.ReadSessionGoal(hostHome, providerID, sessionID)
	if found && goal.Active {
		if condition := strings.TrimSpace(goal.Condition); condition != "" {
			return "/goal " + condition, true
		}
	}
	return "continue", true
}

func familyContinuationPromptForRuntime(
	providerID string,
	sessionID string,
	runtime commandRuntime,
) (string, bool) {
	hostHome, err := runtime.userHomeDir()
	if err != nil || strings.TrimSpace(hostHome) == "" {
		return "", false
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return familyLatestContinuationPrompt(providerID, runtime)
	}
	return familyContinuationPrompt(hostHome, providerID, sessionID)
}
