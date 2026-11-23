package remoteconnector

import (
	"errors"
	"time"
)

// Error codes are shared by the Server, the local connector and every management
// adapter. They are deliberately stable: UI text may change, these strings are
// the machine-readable contract.
const (
	CodeInvalidToken           = "invalid_token"
	CodeEnrollmentExpired      = "enrollment_expired"
	CodeEnrollmentUsed         = "enrollment_used"
	CodeEnrollmentNotFound     = "enrollment_not_found"
	CodeWorkspaceNotFound      = "workspace_not_found"
	CodeWorkspaceRevoked       = "workspace_revoked"
	CodeWorkspaceOffline       = "workspace_offline"
	CodeWorkspaceLimit         = "workspace_limit_reached"
	CodeCapabilityNotAllowed   = "capability_not_allowed"
	CodeUnsupportedOperation   = "unsupported_operation"
	CodeInvalidPath            = "invalid_path"
	CodePathOutsideWorkspace   = "path_outside_workspace"
	CodePathNotFound           = "path_not_found"
	CodePermissionDenied       = "permission_denied"
	CodeNotAFile               = "not_a_file"
	CodeNotADirectory          = "not_a_directory"
	CodeFileTooLarge           = "file_too_large"
	CodeVersionConflict        = "version_conflict"
	CodeInvalidPayload         = "invalid_payload"
	CodeInvalidQuery           = "invalid_query"
	CodeJobNotFound            = "job_not_found"
	CodeJobLimit               = "job_limit_reached"
	CodeApprovalRequired       = "approval_required"
	CodeApprovalNotFound       = "approval_not_found"
	CodeApprovalDenied         = "approval_denied"
	CodeApprovalExpired        = "approval_expired"
	CodeApprovalUsed           = "approval_used"
	CodeRequestTimeout         = "request_timeout"
	CodeProtocolError          = "protocol_error"
	CodeConnectorSuperseded    = "connector_superseded"
	CodeConnectorDisconnected  = "connector_disconnected"
	CodeServerUnsupported      = "server_does_not_accept_requests"
	CodeWorkspaceNotEnumerable = "workspace_not_enumerable"
	CodeWorkspaceNotReadable   = "workspace_not_readable"
	CodeWorkspaceNotWritable   = "workspace_not_writable"
	CodeWorkspaceNotSearchable = "workspace_not_searchable"
	CodeInternal               = "internal_error"
)

// ProtocolError is the only error shape that crosses the connector protocol.
// It never contains local paths, credentials or raw OS errors.
type ProtocolError struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

func (err *ProtocolError) Error() string {
	if err == nil {
		return CodeInternal
	}
	if err.Message == "" {
		return err.Code
	}
	return err.Code + ": " + err.Message
}

// ErrorCode returns the stable code for a protocol error, or the internal code
// for an unexpected error. It must not leak the wrapped error text.
func ErrorCode(err error) string {
	var protocolErr *ProtocolError
	if errors.As(err, &protocolErr) && protocolErr != nil && protocolErr.Code != "" {
		return protocolErr.Code
	}
	return CodeInternal
}

// NewProtocolError builds a bounded error without wrapping OS text.
func NewProtocolError(code, message string) *ProtocolError {
	return &ProtocolError{Code: code, Message: message}
}

// IsPermanent reports whether retrying the same connector token cannot succeed.
// Transient transport and server errors return false so callers can reconnect.
func IsPermanent(code string) bool {
	switch code {
	case CodeInvalidToken, CodeEnrollmentExpired, CodeEnrollmentUsed, CodeEnrollmentNotFound,
		CodeWorkspaceNotFound, CodeWorkspaceRevoked, CodeCapabilityNotAllowed,
		CodeProtocolError, CodeUnsupportedOperation, CodeServerUnsupported:
		return true
	default:
		return false
	}
}

// NormalizeCapabilities converts a name-only declaration into the boolean form
// used by dispatch. Bools remain authoritative when both are present.
func NormalizeCapabilities(capabilities Capabilities) Capabilities {
	if len(capabilities.Names) == 0 {
		capabilities.Names = capabilities.NamesOrDerived()
		return capabilities
	}
	for _, name := range capabilities.Names {
		switch name {
		case CapabilityReadFile:
			capabilities.ReadFile = true
		case CapabilityWriteFile:
			capabilities.WriteFile = true
		case CapabilityListDirectory:
			capabilities.ListDirectory = true
		case CapabilitySearch:
			capabilities.Search = true
		case CapabilityRunCommand:
			capabilities.RunCommand = true
		case CapabilityApproval:
			capabilities.Approval = true
		case CapabilityStartJob:
			capabilities.StartJob = true
		case CapabilityWatchJob:
			capabilities.WatchJob = true
		case CapabilityInterruptJob:
			capabilities.InterruptJob = true
		}
	}
	capabilities.Names = capabilities.NamesOrDerived()
	return capabilities
}

// IntersectCapabilities keeps only capabilities both sides declare. The Server
// uses this to enforce the enrollment grant even when a connector claims more.
func IntersectCapabilities(allowed, declared Capabilities) Capabilities {
	allowed = NormalizeCapabilities(allowed)
	declared = NormalizeCapabilities(declared)
	result := Capabilities{
		ReadFile:      allowed.ReadFile && declared.ReadFile,
		WriteFile:     allowed.WriteFile && declared.WriteFile,
		ListDirectory: allowed.ListDirectory && declared.ListDirectory,
		Search:        allowed.Search && declared.Search,
		RunCommand:    allowed.RunCommand && declared.RunCommand,
		Approval:      allowed.Approval && declared.Approval,
		StartJob:      allowed.StartJob && declared.StartJob,
		WatchJob:      allowed.WatchJob && declared.WatchJob,
		InterruptJob:  allowed.InterruptJob && declared.InterruptJob,
	}
	result.Names = result.NamesOrDerived()
	return result
}

// SupportsOperation reports whether a normalized capability declaration allows
// one operation. Unknown operations are never allowed.
func SupportsOperation(capabilities Capabilities, operation string) bool {
	capabilities = NormalizeCapabilities(capabilities)
	switch operation {
	case OperationReadFile:
		return capabilities.ReadFile
	case OperationWriteFile:
		return capabilities.WriteFile
	case OperationListDirectory:
		return capabilities.ListDirectory
	case OperationSearch:
		return capabilities.Search
	case OperationRunCommand:
		return capabilities.RunCommand
	case OperationListApprovals, OperationDecideApproval:
		return capabilities.Approval
	case OperationStartJob:
		return capabilities.StartJob
	case OperationWatchJob:
		return capabilities.WatchJob
	case OperationInterruptJob:
		return capabilities.InterruptJob
	default:
		return false
	}
}

// ReadFileRequest asks for one regular file inside the connector workspace.
type ReadFileRequest struct {
	Path     string `json:"path"`
	MaxBytes int64  `json:"maxBytes,omitempty"`
}

// ReadFileResult carries base64 content so the protocol stays text-safe.
// Version is a content hash used by WriteFileRequest.ExpectedVersion.
type ReadFileResult struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Encoding  string `json:"encoding"`
	Version   string `json:"version"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated,omitempty"`
}

// WriteFileRequest writes base64 content atomically. An empty ExpectedVersion
// means "the file must not exist yet"; a non-empty value must match the current
// content version. This prevents lost updates from concurrent tool calls.
type WriteFileRequest struct {
	Path            string `json:"path"`
	Content         string `json:"content"`
	Encoding        string `json:"encoding,omitempty"`
	ExpectedVersion string `json:"expectedVersion,omitempty"`
}

type WriteFileResult struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Size    int64  `json:"size"`
}

type ListDirectoryRequest struct {
	Path  string `json:"path,omitempty"`
	Limit int    `json:"limit,omitempty"`
}

// DirectoryEntry describes a single child. Version is omitted for directories,
// symlinks and files above the versioning limit.
type DirectoryEntry struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Size    int64  `json:"size,omitempty"`
	ModTime int64  `json:"modTime,omitempty"`
	Version string `json:"version,omitempty"`
}

type ListDirectoryResult struct {
	Path      string           `json:"path"`
	Entries   []DirectoryEntry `json:"entries"`
	Truncated bool             `json:"truncated,omitempty"`
}

const (
	SearchModePath    = "path"
	SearchModeContent = "content"
)

type SearchRequest struct {
	Path  string `json:"path,omitempty"`
	Query string `json:"query"`
	// Mode defaults to path. Content mode scans bounded text files with the
	// query as a Go regular expression.
	Mode       string `json:"mode,omitempty"`
	MaxResults int    `json:"maxResults,omitempty"`
	MaxDepth   int    `json:"maxDepth,omitempty"`
}

type SearchMatch struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size,omitempty"`
	Line int    `json:"line,omitempty"`
	Text string `json:"text,omitempty"`
}

type SearchResult struct {
	Matches   []SearchMatch `json:"matches"`
	Truncated bool          `json:"truncated,omitempty"`
}

const (
	// DefaultCommandTimeout bounds one run_command call when the caller does
	// not ask for a different timeout.
	DefaultCommandTimeout = 120 * time.Second
	// MaxCommandTimeout is the hard ceiling shared by the Server tool endpoint
	// and the local connector. run_command is synchronous; durable jobs are a
	// separate protocol (workspace.start_job).
	MaxCommandTimeout = 10 * time.Minute
)

// RunCommandRequest runs one shell command with the workspace root (or a
// confined subdirectory) as its working directory. Cwd confinement is not an
// OS sandbox: the command runs with the local user's own authority.
type RunCommandRequest struct {
	Command    string `json:"command"`
	Cwd        string `json:"cwd,omitempty"`
	TimeoutMS  int    `json:"timeoutMs,omitempty"`
	ApprovalID string `json:"approvalId,omitempty"`
}

// RunCommandResult carries base64 streams so arbitrary command output survives
// the JSON envelope. ExitCode is -1 when the process did not exit on its own.
type RunCommandResult struct {
	Cwd        string `json:"cwd"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	Encoding   string `json:"encoding"`
	ExitCode   int    `json:"exitCode"`
	Truncated  bool   `json:"truncated,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	DurationMS int64  `json:"durationMs"`
}

const (
	// DefaultJobTimeout bounds a background job lifetime when the caller does
	// not ask for a different one.
	DefaultJobTimeout = 30 * time.Minute
	// MaxJobTimeout is the hard ceiling for a background job.
	MaxJobTimeout = 2 * time.Hour
	// MaxJobWait bounds one watch_job long-poll; callers poll again with the
	// returned cursor.
	MaxJobWait = 30 * time.Second
)

// Job states are stable machine-readable values shared by the connector, the
// Server tool layer and the agent-facing tool output.
const (
	JobRunning     = "running"
	JobExited      = "exited"
	JobFailed      = "failed"
	JobTimedOut    = "timed_out"
	JobInterrupted = "interrupted"
	JobLost        = "lost"
)

// StartJobRequest starts one detached command. The local connector supervises
// it through an on-disk spool, so the job outlives the RPC, the Server session
// and connector restarts.
type StartJobRequest struct {
	Command    string `json:"command"`
	Cwd        string `json:"cwd,omitempty"`
	TimeoutMS  int    `json:"timeoutMs,omitempty"`
	ApprovalID string `json:"approvalId,omitempty"`
}

type StartJobResult struct {
	JobID       string `json:"jobId"`
	State       string `json:"state"`
	Cwd         string `json:"cwd"`
	StdoutStart int64  `json:"stdoutStart"`
	StderrStart int64  `json:"stderrStart"`
	StartedAt   int64  `json:"startedAt"`
}

// WatchJobRequest reads output after the given absolute byte offsets. Offsets
// are per stream and never regress; the caller passes back what it consumed.
type WatchJobRequest struct {
	JobID        string `json:"jobId"`
	StdoutOffset int64  `json:"stdoutOffset,omitempty"`
	StderrOffset int64  `json:"stderrOffset,omitempty"`
	WaitMS       int    `json:"waitMs,omitempty"`
}

type WatchJobResult struct {
	JobID        string `json:"jobId"`
	State        string `json:"state"`
	ExitCode     int    `json:"exitCode"`
	Stdout       string `json:"stdout"`
	Stderr       string `json:"stderr"`
	Encoding     string `json:"encoding"`
	StdoutOffset int64  `json:"stdoutOffset"`
	StderrOffset int64  `json:"stderrOffset"`
	Dropped      bool   `json:"dropped,omitempty"`
	Truncated    bool   `json:"truncated,omitempty"`
	StartedAt    int64  `json:"startedAt"`
	EndedAt      int64  `json:"endedAt,omitempty"`
	DurationMS   int64  `json:"durationMs"`
}

type InterruptJobRequest struct {
	JobID string `json:"jobId"`
}

type InterruptJobResult struct {
	JobID  string `json:"jobId"`
	State  string `json:"state"`
	Forced bool   `json:"forced,omitempty"`
}

// JobTimeout converts a caller-supplied millisecond budget into a bounded
// duration. Zero or negative selects the default.
func JobTimeout(timeoutMS int) time.Duration {
	timeout := DefaultJobTimeout
	if timeoutMS > 0 {
		timeout = time.Duration(timeoutMS) * time.Millisecond
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	if timeout > MaxJobTimeout {
		timeout = MaxJobTimeout
	}
	return timeout
}

// JobWait bounds one watch long-poll.
func JobWait(waitMS int) time.Duration {
	wait := time.Duration(waitMS) * time.Millisecond
	if wait < 0 {
		wait = 0
	}
	if wait > MaxJobWait {
		wait = MaxJobWait
	}
	return wait
}

// Approval states are stable machine-readable values.
const (
	ApprovalPending  = "pending"
	ApprovalApproved = "approved"
	ApprovalDenied   = "denied"
	ApprovalUsed     = "used"
	ApprovalExpired  = "expired"
)

// Approval modes are declared by the local connector at connect time.
const (
	ApprovalModeNever       = "never"
	ApprovalModeDestructive = "destructive"
	ApprovalModeAll         = "all"
)

// ApprovalRequest is the view of one command waiting for a local decision.
// The command text is shown to the user; it is never echoed back to the agent
// through this endpoint.
type ApprovalRequest struct {
	ID        string `json:"id"`
	Command   string `json:"command"`
	Cwd       string `json:"cwd"`
	State     string `json:"state"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

type ListApprovalsResult struct {
	Mode      string            `json:"mode"`
	Approvals []ApprovalRequest `json:"approvals"`
}

type DecideApprovalRequest struct {
	ID      string `json:"id"`
	Approve bool   `json:"approve"`
}

type DecideApprovalResult struct {
	Approval ApprovalRequest `json:"approval"`
}

// CommandTimeout converts a caller-supplied millisecond budget into a bounded
// duration. Zero or negative selects the default.
func CommandTimeout(timeoutMS int) time.Duration {
	timeout := DefaultCommandTimeout
	if timeoutMS > 0 {
		timeout = time.Duration(timeoutMS) * time.Millisecond
	}
	if timeout < time.Second {
		timeout = time.Second
	}
	if timeout > MaxCommandTimeout {
		timeout = MaxCommandTimeout
	}
	return timeout
}
