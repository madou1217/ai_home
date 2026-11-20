//go:build darwin

package accountbrowserhost

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"time"
)

const edgeBundle = "/Applications/Microsoft Edge.app"

var stableVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$`)

func discover(ctx context.Context) (installation, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	bundle, err := filepath.EvalSymlinks(edgeBundle)
	if err != nil || bundle != edgeBundle {
		return installation{}, ErrUnavailable
	}
	metadata, err := exec.CommandContext(ctx, "/usr/bin/plutil", "-convert", "json", "-o", "-", edgeBundle+"/Contents/Info.plist").Output()
	if err != nil || len(metadata) > 1024*1024 {
		return installation{}, ErrUnavailable
	}
	var info struct {
		ID         string `json:"CFBundleIdentifier"`
		Name       string `json:"CFBundleName"`
		Executable string `json:"CFBundleExecutable"`
		Version    string `json:"CFBundleShortVersionString"`
	}
	if json.Unmarshal(metadata, &info) != nil || info.ID != "com.microsoft.edgemac" || info.Name != "Edge" || info.Executable != "Microsoft Edge" || !stableVersion.MatchString(info.Version) {
		return installation{}, ErrUnavailable
	}
	requirement := `identifier "com.microsoft.edgemac" and anchor apple generic and certificate leaf[subject.OU] = "UBF8T346G9"`
	// Verify the installed signature without altering bundle attributes. Strict
	// resource/xattr policy is not required to establish the signed identity.
	if exec.CommandContext(ctx, "/usr/bin/codesign", "--verify", "-R="+requirement, edgeBundle).Run() != nil {
		return installation{}, ErrUnavailable
	}
	executable := edgeBundle + "/Contents/MacOS/Microsoft Edge"
	canonical, err := filepath.EvalSymlinks(executable)
	if err != nil || canonical != executable {
		return installation{}, ErrUnavailable
	}
	file, err := os.Stat(executable)
	if err != nil || !file.Mode().IsRegular() || file.Mode().Perm()&0o111 == 0 {
		return installation{}, ErrUnavailable
	}
	return installation{identity: BrowserIdentity{Vendor: "Microsoft Edge", Channel: "stable", Version: info.Version}, executable: executable}, nil
}
