package main

import (
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
)

type familySessionBudget struct{}

func (familySessionBudget) Take() bool      { return true }
func (familySessionBudget) OutOfTime() bool { return false }

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

// familyLatestContinuationPrompt 仅用于显式 resume（不带 id）：
// 用户已明确表达“续最近一段”，此时才允许查找当前目录最近的会话。
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
