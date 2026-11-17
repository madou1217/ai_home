// Package distributionupdate owns distribution-update hints and explicitly
// confirmed restart appointments. It never runs an installer in this process.
// CLI, WebUI and the host must share this service and its private on-disk state.
package distributionupdate

import (
	"context"
	"errors"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/distributionrelease"
)

var (
	ErrClosed          = errors.New("distribution update service is closed")
	ErrLocked          = errors.New("distribution update state is locked")
	ErrWorkerBusy      = errors.New("distribution update worker is already active")
	ErrCheckInProgress = errors.New("distribution release check is already active")
	ErrNoRelease       = errors.New("check the selected release before scheduling")
	ErrScheduleActive  = errors.New("a distribution update is already scheduled")
	ErrNotCancellable  = errors.New("only queued or deferred updates can be cancelled")
	ErrInvalidSchedule = errors.New("invalid distribution update schedule")
	ErrInvalidState    = errors.New("invalid distribution update state")
	ErrNotDistribution = errors.New("restart-to-install requires a distribution build")
	ErrBusyUnknown     = errors.New("cannot establish whether the host is idle")
)

// Options are trusted host composition, never HTTP request fields. All callbacks
// must honor ctx. Busy must include installer/executor activity as well as active
// user work. A missing or failing Busy callback fails closed (five-minute defer).
// Apply MUST only spawn an independent, detached executor and return promptly;
// returning nil means handedoff, NEVER installed. ReadReceipt defaults to the
// native installer's Home/distribution-install.json contract, without importing
// the installer. VerifyRuntime defaults to checking the real live native
// runtime identity and executable hash against that receipt. A custom verifier
// must prove the same facts. No callback error text is written to private JSON.
type Options struct {
	Home           string
	PackageRoot    string
	CurrentVersion string // optional; otherwise BUILD_INFO.json/package.json
	Target         string // optional; otherwise BUILD_INFO.json/host target
	Check          func(context.Context) (distributionrelease.ReleaseInfo, error)
	Download       func(context.Context, distributionrelease.ReleaseInfo, string) (string, error)
	Apply          func(context.Context, string) error
	Busy           func(context.Context) (bool, string, error)
	ReadReceipt    func(context.Context) (Receipt, error)
	VerifyRuntime  func(context.Context, Receipt) error
	OnError        func(error)
	Now            func() time.Time
	StartupDelay   time.Duration // defaults to 30 seconds
	CheckInterval  time.Duration // defaults to 6 hours
	TickInterval   time.Duration // defaults to 1 minute
	DeferInterval  time.Duration // defaults to 5 minutes
	ReceiptTimeout time.Duration // defaults to 30 minutes; never retries apply
}

// BuildInfo consumes the existing scripts/package/bundle.js BUILD_INFO contract.
type BuildInfo struct {
	Name      string    `json:"name"`
	Version   string    `json:"version"`
	Target    string    `json:"target"`
	SourceSHA string    `json:"source_sha"`
	BuiltAt   time.Time `json:"built_at"`
	BundledUI bool      `json:"bundled_ui"`
}

type CurrentInfo struct {
	Version     string     `json:"version"`
	Target      string     `json:"target"`
	PackageRoot string     `json:"packageRoot"`
	Source      string     `json:"source"` // distribution, source, or unknown
	Build       *BuildInfo `json:"build,omitempty"`
}

// Receipt is a focused projection of the native installer's receipt. Injected
// readers must return this actual durable receipt, not executor spawn status.
type Receipt struct {
	State          string    `json:"state"`
	Home           string    `json:"home"`
	ReleaseVersion string    `json:"releaseVersion"`
	Target         string    `json:"target"`
	InstalledAt    time.Time `json:"installedAt"`
	Transaction    string    `json:"transaction"`
	PackageRoot    string    `json:"packageRoot"`
	Executable     string    `json:"executable"`
	BinarySHA256   string    `json:"binarySha256"`
}

type ScheduleStatus string

const (
	StatusQueued      ScheduleStatus = "queued"
	StatusDeferred    ScheduleStatus = "deferred"
	StatusDownloading ScheduleStatus = "downloading"
	StatusInstalling  ScheduleStatus = "installing" // HandedOffAt distinguishes executor handoff
	StatusSucceeded   ScheduleStatus = "succeeded"
	StatusFailed      ScheduleStatus = "failed"
	StatusCancelled   ScheduleStatus = "cancelled"
)

type Stage string

const (
	StageDownload Stage = "download"
	StageInstall  Stage = "install"
)

type ScheduledUpdate struct {
	ID               string                          `json:"id"`
	Version          string                          `json:"version"`
	FixedReleaseInfo distributionrelease.ReleaseInfo `json:"fixedReleaseInfo"`
	At               time.Time                       `json:"at"`
	Timezone         string                          `json:"timezone"`
	NextAttemptAt    time.Time                       `json:"nextAttemptAt"`
	Status           ScheduleStatus                  `json:"status"`
	Stage            Stage                           `json:"stage,omitempty"`
	Confirmed        bool                            `json:"confirmed"`
	DeferredReason   string                          `json:"deferredReason,omitempty"`
	Error            string                          `json:"error,omitempty"` // bounded codes, not raw errors
	ArtifactPath     string                          `json:"artifactPath,omitempty"`
	CreatedAt        time.Time                       `json:"createdAt"`
	UpdatedAt        time.Time                       `json:"updatedAt"`
	StartedAt        time.Time                       `json:"startedAt,omitempty,omitzero"`
	HandedOffAt      time.Time                       `json:"handedOffAt,omitempty,omitzero"`
	FinishedAt       time.Time                       `json:"finishedAt,omitempty,omitzero"`
}

type Status struct {
	Error         string                           `json:"error,omitempty"`
	SchemaVersion int                              `json:"schemaVersion"`
	Current       CurrentInfo                      `json:"current"`
	Latest        *distributionrelease.ReleaseInfo `json:"latest,omitempty"`
	CheckedAt     time.Time                        `json:"checkedAt,omitempty,omitzero"`
	NextCheckAt   time.Time                        `json:"nextCheckAt,omitempty,omitzero"`
	CheckError    string                           `json:"checkError,omitempty"`
	Schedule      *ScheduledUpdate                 `json:"schedule,omitempty"`
}

func pending(status ScheduleStatus) bool { return status == StatusQueued || status == StatusDeferred }
func running(status ScheduleStatus) bool {
	return status == StatusDownloading || status == StatusInstalling
}
func terminal(status ScheduleStatus) bool {
	return status == StatusSucceeded || status == StatusFailed || status == StatusCancelled
}
