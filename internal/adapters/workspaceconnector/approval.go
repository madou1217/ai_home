package workspaceconnector

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	approvalTTL        = 10 * time.Minute
	approvalRetention  = 30 * time.Minute
	maxApprovalRecords = 32
)

// destructiveCommandPatterns is a conservative heuristic for commands that
// need a human decision. It is not a sandbox: approval=all is the strict mode.
var destructiveCommandPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(^|[;&|]|\s)rm\s+(-[a-z]*[rf][a-z]*\s+)+`),
	regexp.MustCompile(`(^|[;&|]|\s)sudo(\s|$)`),
	regexp.MustCompile(`(^|[;&|]|\s)(shutdown|reboot|halt|poweroff)(\s|$)`),
	regexp.MustCompile(`(^|[;&|]|\s)mkfs(\.|\s|$)`),
	regexp.MustCompile(`(^|[;&|]|\s)dd\s+[^;|&]*of=`),
	regexp.MustCompile(`git\s+push(\s|$)`),
	regexp.MustCompile(`git\s+reset\s+--hard(\s|$)`),
	regexp.MustCompile(`git\s+clean\s+-[a-z]*[fd]`),
	regexp.MustCompile(`(curl|wget)[^|;]*\|\s*(sh|bash|zsh)(\s|$)`),
	regexp.MustCompile(`chmod\s+(-[a-zA-Z]+\s+)*777(\s|$)`),
}

// approvalManager decides whether one command may run unattended and keeps the
// pending decisions the user can approve from AIH.
type approvalManager struct {
	mu    sync.Mutex
	mode  string
	items map[string]*approvalRecord
}

type approvalRecord struct {
	id        string
	command   string
	cwd       string
	hash      string
	state     string
	createdAt time.Time
	expiresAt time.Time
}

func newApprovalManager(mode string) *approvalManager {
	return &approvalManager{mode: normalizeApprovalMode(mode), items: make(map[string]*approvalRecord)}
}

func normalizeApprovalMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case remoteconnector.ApprovalModeNever:
		return remoteconnector.ApprovalModeNever
	case remoteconnector.ApprovalModeAll:
		return remoteconnector.ApprovalModeAll
	default:
		return remoteconnector.ApprovalModeDestructive
	}
}

func (manager *approvalManager) Mode() string { return manager.mode }

// Require either lets the command through or returns approval_required with the
// id the agent should ask the user to approve. A retry must carry the same
// command text and cwd plus the approved id.
func (manager *approvalManager) Require(command, cwd, approvalID string) error {
	if manager.mode == remoteconnector.ApprovalModeNever {
		return nil
	}
	if manager.mode == remoteconnector.ApprovalModeDestructive && !destructiveCommand(command) {
		return nil
	}
	hash := approvalHash(command, cwd)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.pruneLocked(time.Now())
	if id := strings.TrimSpace(approvalID); id != "" {
		record, found := manager.items[id]
		if !found || record.hash != hash {
			return remoteconnector.NewProtocolError(remoteconnector.CodeApprovalNotFound, "approval does not exist for this command")
		}
		switch record.state {
		case remoteconnector.ApprovalApproved:
			record.state = remoteconnector.ApprovalUsed
			return nil
		case remoteconnector.ApprovalDenied:
			return remoteconnector.NewProtocolError(remoteconnector.CodeApprovalDenied, "the user denied this command")
		case remoteconnector.ApprovalUsed:
			return remoteconnector.NewProtocolError(remoteconnector.CodeApprovalUsed, "this approval was already used")
		case remoteconnector.ApprovalExpired:
			return remoteconnector.NewProtocolError(remoteconnector.CodeApprovalExpired, "this approval has expired")
		default:
			return remoteconnector.NewProtocolError(remoteconnector.CodeApprovalRequired, "approval is still pending: "+record.id)
		}
	}
	if len(manager.items) >= maxApprovalRecords {
		return remoteconnector.NewProtocolError(remoteconnector.CodeApprovalRequired, "too many pending approvals; ask the user to review AIH approvals first")
	}
	id := newApprovalID()
	now := time.Now()
	manager.items[id] = &approvalRecord{
		id: id, command: command, cwd: cwd, hash: hash, state: remoteconnector.ApprovalPending,
		createdAt: now, expiresAt: now.Add(approvalTTL),
	}
	return remoteconnector.NewProtocolError(remoteconnector.CodeApprovalRequired,
		fmt.Sprintf("approval %s is required; ask the user to approve it in AIH, then retry the same command with approval_id=%s", id, id))
}

func (manager *approvalManager) List() remoteconnector.ListApprovalsResult {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.pruneLocked(time.Now())
	result := remoteconnector.ListApprovalsResult{Mode: manager.mode, Approvals: make([]remoteconnector.ApprovalRequest, 0, len(manager.items))}
	for _, record := range manager.items {
		if record.state != remoteconnector.ApprovalPending && record.state != remoteconnector.ApprovalApproved {
			continue
		}
		result.Approvals = append(result.Approvals, record.view())
	}
	sort.Slice(result.Approvals, func(left, right int) bool {
		return result.Approvals[left].CreatedAt < result.Approvals[right].CreatedAt
	})
	return result
}

func (manager *approvalManager) Decide(id string, approve bool) (remoteconnector.ApprovalRequest, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return remoteconnector.ApprovalRequest{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "approval id is required")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.pruneLocked(time.Now())
	record, found := manager.items[id]
	if !found {
		return remoteconnector.ApprovalRequest{}, remoteconnector.NewProtocolError(remoteconnector.CodeApprovalNotFound, "approval does not exist")
	}
	switch record.state {
	case remoteconnector.ApprovalPending:
	case remoteconnector.ApprovalExpired:
		return remoteconnector.ApprovalRequest{}, remoteconnector.NewProtocolError(remoteconnector.CodeApprovalExpired, "approval has expired")
	default:
		return remoteconnector.ApprovalRequest{}, remoteconnector.NewProtocolError(remoteconnector.CodeApprovalUsed, "approval was already decided")
	}
	if approve {
		record.state = remoteconnector.ApprovalApproved
	} else {
		record.state = remoteconnector.ApprovalDenied
	}
	return record.view(), nil
}

func (manager *approvalManager) pruneLocked(now time.Time) {
	for id, record := range manager.items {
		if record.state == remoteconnector.ApprovalPending && now.After(record.expiresAt) {
			record.state = remoteconnector.ApprovalExpired
		}
		if now.Sub(record.createdAt) > approvalRetention {
			delete(manager.items, id)
		}
	}
}

func (record *approvalRecord) view() remoteconnector.ApprovalRequest {
	return remoteconnector.ApprovalRequest{
		ID: record.id, Command: record.command, Cwd: displayApprovalCwd(record.cwd),
		State: record.state, CreatedAt: record.createdAt.UnixMilli(), ExpiresAt: record.expiresAt.UnixMilli(),
	}
}

func displayApprovalCwd(cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return "."
	}
	return cwd
}

func approvalHash(command, cwd string) string {
	sum := sha256.Sum256([]byte(command + "\x00" + strings.TrimSpace(cwd)))
	return hex.EncodeToString(sum[:])
}

func newApprovalID() string {
	buffer := make([]byte, 9)
	if _, err := rand.Read(buffer); err != nil {
		return "ap-000000000000000000"
	}
	return "ap-" + hex.EncodeToString(buffer)
}

func destructiveCommand(command string) bool {
	normalized := strings.ToLower(command)
	for _, pattern := range destructiveCommandPatterns {
		if pattern.MatchString(normalized) {
			return true
		}
	}
	return false
}
