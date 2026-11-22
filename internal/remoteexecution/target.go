// Package remoteexecution contains the provider-neutral remote execution target model.
//
// The package deliberately has no HTTP, SSH, filesystem or provider-launch dependency.
// It is the stable boundary shared by CLI, WebUI and the future remote Agent supervisor.
package remoteexecution

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
)

const (
	TransportSSH       = "ssh"
	TransportConnector = "connector"

	StageServer    = "server"
	StageWorkspace = "workspace"
	StageRunner    = "runner"
	StageProvider  = "provider"
	StageAccount   = "account"
	StageModel     = "model"
	StageTools     = "tools"
)

const (
	StatusOK          = "ok"
	StatusBlocked     = "blocked"
	StatusUnsupported = "unsupported"
	StatusUnknown     = "unknown"
)

var (
	ErrInvalidFacts     = errors.New("remote execution facts are invalid")
	ErrTargetNotFound   = errors.New("remote execution target not found")
	ErrTargetAmbiguous  = errors.New("remote execution target is ambiguous")
	ErrTargetIncomplete = errors.New("remote execution target is incomplete")
)

// TargetSelector is the user-facing target selection. Empty fields are resolved
// only when the facts contain exactly one unambiguous candidate.
type TargetSelector struct {
	ServerProfileID string `json:"serverProfileId,omitempty"`
	ServerID        string `json:"serverId,omitempty"`
	WorkspaceID     string `json:"workspaceId,omitempty"`
	ConnectionID    string `json:"connectionId,omitempty"`
	Harness         string `json:"harness,omitempty"`
	Provider        string `json:"provider,omitempty"`
	AccountRef      string `json:"accountRef,omitempty"`
	Model           string `json:"model,omitempty"`
}

// WorkspaceFact is a sanitized remote workspace identity. RemoteRoot is the
// real project root on the SSH host; no shadow project path belongs here.
type WorkspaceFact struct {
	ID              string `json:"id"`
	Transport       string `json:"transport,omitempty"`
	ConnectionID    string `json:"connectionId,omitempty"`
	ConnectionLabel string `json:"connectionLabel,omitempty"`
	Host            string `json:"host,omitempty"`
	ConnectorID     string `json:"connectorId,omitempty"`
	// State is meaningful for connector workspaces: online / offline / revoked.
	// SSH workspaces leave it empty because this projection does not probe them.
	State      string `json:"state,omitempty"`
	Label      string `json:"label"`
	RemoteRoot string `json:"remoteRoot,omitempty"`
	// RootLabel is a display-only label supplied by a local connector. It must
	// never be interpreted as a Server-side filesystem path.
	RootLabel string `json:"rootLabel,omitempty"`
}

// RunnerFact describes an Agent/Harness capability without claiming that a
// provider CLI can actually operate a remote workspace.
type RunnerFact struct {
	ID                  string   `json:"id"`
	Provider            string   `json:"provider,omitempty"`
	Kind                string   `json:"kind"`
	Status              string   `json:"status"`
	SupportsHeadless    bool     `json:"supportsHeadless"`
	SupportsRemoteTools bool     `json:"supportsRemoteTools"`
	SupportsApproval    bool     `json:"supportsApproval"`
	Capabilities        []string `json:"capabilities,omitempty"`
	Reason              string   `json:"reason,omitempty"`
}

// AccountFact contains only non-secret account identity and model evidence.
type AccountFact struct {
	AccountRef        string `json:"accountRef"`
	// CLIAccountID is the provider-local numeric alias accepted by aih's
	// account launch path. It is not a credential.
	CLIAccountID      string `json:"cliAccountId,omitempty"`
	Provider          string `json:"provider"`
	Enabled           bool   `json:"enabled"`
	CredentialKnown   bool   `json:"credentialKnown"`
	ModelCount        int    `json:"modelCount"`
	EffectiveModels   int    `json:"effectiveModels"`
	ModelCatalogKnown bool   `json:"modelCatalogKnown"`
}

// ModelFact keeps catalog identity and the runtime CLI mapping separate.
type ModelFact struct {
	AccountRef            string `json:"accountRef"`
	Provider              string `json:"provider"`
	CatalogModelID        string `json:"catalogModelId"`
	CLIModelName          string `json:"cliModelName,omitempty"`
	Effective             bool   `json:"effective"`
	CatalogAvailable      bool   `json:"catalogAvailable"`
	NativeLaunchAvailable bool   `json:"nativeLaunchAvailable"`
}

// Facts is the server-side snapshot used by the resolver. A caller should load
// one snapshot per request so a resolved target is internally consistent.
type Facts struct {
	ServerID   string          `json:"serverId"`
	Workspaces []WorkspaceFact `json:"workspaces"`
	Runners    []RunnerFact    `json:"runners"`
	Accounts   []AccountFact   `json:"accounts"`
	Models     []ModelFact     `json:"models"`
}

// ExecutionTarget is the immutable identity passed to a future Agent/Job
// supervisor. It never contains a secret or a shadow project path.
type ExecutionTarget struct {
	ID              string `json:"id"`
	ServerProfileID string `json:"serverProfileId,omitempty"`
	ServerID        string `json:"serverId"`
	WorkspaceID     string `json:"workspaceId"`
	ConnectionID    string `json:"connectionId"`
	WorkspaceRoot   string `json:"workspaceRoot"`
	Harness         string `json:"harness"`
	Provider        string `json:"provider"`
	AccountRef      string `json:"accountRef"`
	CatalogModelID  string `json:"catalogModelId"`
	CLIModelName    string `json:"cliModelName,omitempty"`
	Transport       string `json:"transport"`
	// RootLabel is display-only for connector transport. WorkspaceRoot is the
	// real Server-side path only for SSH transport.
	RootLabel      string `json:"rootLabel,omitempty"`
	PermissionMode string `json:"permissionMode,omitempty"`
}

// TargetCandidate is the safe list representation before all selectors have
// been resolved. It is intentionally not executable by itself.
type TargetCandidate struct {
	ID        string          `json:"id"`
	ServerID  string          `json:"serverId"`
	Workspace WorkspaceFact   `json:"workspace"`
	Runner    RunnerFact      `json:"runner"`
	Account   AccountFact     `json:"account"`
	Model     ModelFact       `json:"model"`
	Preflight PreflightReport `json:"preflight"`
}

// Resolution is returned by both CLI and HTTP adapters so they can render the
// same target and diagnostic data.
type Resolution struct {
	Target    ExecutionTarget `json:"target"`
	Preflight PreflightReport `json:"preflight"`
}

// ResolutionError is a stable, machine-readable selection failure.
type ResolutionError struct {
	Code   string
	Field  string
	Value  string
	Detail string
}

func (err *ResolutionError) Error() string {
	if err == nil {
		return "remote execution target resolution failed"
	}
	if err.Detail != "" {
		return fmt.Sprintf("%s: %s", err.Code, err.Detail)
	}
	if err.Field != "" {
		return fmt.Sprintf("%s (%s=%s)", err.Code, err.Field, err.Value)
	}
	return err.Code
}

func (err *ResolutionError) Unwrap() error {
	switch err.Code {
	case "target_not_found":
		return ErrTargetNotFound
	case "target_ambiguous":
		return ErrTargetAmbiguous
	case "target_incomplete":
		return ErrTargetIncomplete
	default:
		return ErrInvalidFacts
	}
}

// NormalizeSelector trims user input without changing model case. Provider,
// harness and IDs are normalized as identifiers; model names remain exact.
func NormalizeSelector(selector TargetSelector) TargetSelector {
	selector.ServerProfileID = strings.TrimSpace(selector.ServerProfileID)
	selector.ServerID = strings.TrimSpace(selector.ServerID)
	selector.WorkspaceID = strings.TrimSpace(selector.WorkspaceID)
	selector.ConnectionID = strings.TrimSpace(selector.ConnectionID)
	selector.Harness = strings.ToLower(strings.TrimSpace(selector.Harness))
	selector.Provider = strings.ToLower(strings.TrimSpace(selector.Provider))
	selector.AccountRef = strings.TrimSpace(selector.AccountRef)
	selector.Model = strings.TrimSpace(selector.Model)
	return selector
}

func BuildTargetID(target ExecutionTarget) string {
	parts := []string{
		target.ServerID,
		target.WorkspaceID,
		target.Harness,
		target.Provider,
		target.AccountRef,
		target.CatalogModelID,
	}
	hash := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return "rt-" + hex.EncodeToString(hash[:12])
}

func sortFacts(facts *Facts) {
	if facts == nil {
		return
	}
	sort.Slice(facts.Workspaces, func(i, j int) bool { return facts.Workspaces[i].ID < facts.Workspaces[j].ID })
	sort.Slice(facts.Runners, func(i, j int) bool { return facts.Runners[i].ID < facts.Runners[j].ID })
	sort.Slice(facts.Accounts, func(i, j int) bool {
		if facts.Accounts[i].Provider != facts.Accounts[j].Provider {
			return facts.Accounts[i].Provider < facts.Accounts[j].Provider
		}
		return facts.Accounts[i].AccountRef < facts.Accounts[j].AccountRef
	})
	sort.Slice(facts.Models, func(i, j int) bool {
		left, right := facts.Models[i], facts.Models[j]
		keyLeft := left.Provider + "\x00" + left.AccountRef + "\x00" + left.CatalogModelID
		keyRight := right.Provider + "\x00" + right.AccountRef + "\x00" + right.CatalogModelID
		return keyLeft < keyRight
	})
}
