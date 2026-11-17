// Package distributioninstall owns the product's distribution install/upgrade
// transaction. It is shared by archive installers, SFX and scheduled updates.
package distributioninstall

import (
	"context"
	"github.com/madou1217/ai_home/internal/runtime/distributiondata"
	"io"
	"time"
)

type Options struct {
	Home        string
	HostHome    string
	PackageRoot string
	Launcher    string
	BinDir      string
	Service     bool
	Output      io.Writer
}
type Build struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Target    string `json:"target"`
	SourceSHA string `json:"source_sha"`
	GoCore    struct {
		Binary string `json:"binary"`
		SHA256 string `json:"sha256"`
	} `json:"go_core"`
	BundledUI bool `json:"bundled_ui"`
}
type Receipt struct {
	Version        int       `json:"version"`
	State          string    `json:"state"`
	Home           string    `json:"home"`
	HostHome       string    `json:"hostHome"`
	PackageRoot    string    `json:"packageRoot"`
	Executable     string    `json:"executable"`
	Launcher       string    `json:"launcher"`
	LauncherSHA256 string    `json:"launcherSha256,omitempty"`
	LauncherLink   string    `json:"launcherLink,omitempty"`
	BinarySHA256   string    `json:"binarySha256"`
	ReleaseVersion string    `json:"releaseVersion"`
	SourceSHA      string    `json:"sourceSha"`
	Target         string    `json:"target"`
	InstalledAt    time.Time `json:"installedAt"`
	Transaction    string    `json:"transaction"`
	Service        bool      `json:"service"`
}
type journal struct {
	ServiceRequested bool                     `json:"serviceRequested"`
	Version          int                      `json:"version"`
	ID               string                   `json:"id"`
	Phase            string                   `json:"phase"`
	Home             string                   `json:"home"`
	Target           string                   `json:"target"`
	PackageRoot      string                   `json:"packageRoot"`
	PreviousLauncher fileRecord               `json:"previousLauncher"`
	PreviousReceipt  fileRecord               `json:"previousReceipt"`
	PreviousBinding  fileRecord               `json:"previousBinding"`
	Service          serviceSnapshot          `json:"service"`
	Data             *distributiondata.Report `json:"data,omitempty"`
	Displaced        []string                 `json:"displaced"`
	Published        []string                 `json:"published"`
	Error            string                   `json:"error,omitempty"`
}
type fileRecord struct {
	Path    string `json:"path"`
	Exists  bool   `json:"exists"`
	Symlink string `json:"symlink,omitempty"`
	Backup  string `json:"backup,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
}
type serviceSnapshot struct {
	// Capture before stop commands can remove the public runtime identity.
	DaemonPID int          `json:"daemonPid,omitempty"`
	GoManaged bool         `json:"goManaged,omitempty"`
	Installed bool         `json:"installed"`
	Running   bool         `json:"running"`
	Files     []fileRecord `json:"files"`
	TaskXML   string       `json:"taskXML,omitempty"`
}
type Result struct {
	OK        bool    `json:"ok"`
	Receipt   Receipt `json:"receipt"`
	Recovered bool    `json:"recovered"`
	Message   string  `json:"message"`
}

type hooks interface {
	Snapshot(context.Context, Options, string) (serviceSnapshot, error)
	Stop(context.Context, Options, serviceSnapshot) error
	Install(context.Context, Options) error
	Restore(context.Context, Options, serviceSnapshot) error
}
