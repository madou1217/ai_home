package hostapps

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

// DesktopProcessDetection reports candidates, never account ownership or stop authority.
// It intentionally does not use Scanner's account projection or error fallback.
type DesktopProcessDetection struct {
	OK            bool                `json:"ok"`
	Supported     bool                `json:"supported"`
	Detected      bool                `json:"detected"`
	Platform      string              `json:"platform"`
	ClientName    string              `json:"clientName"`
	Reason        string              `json:"reason"`
	IdentityScope string              `json:"identityScope"`
	ProcessInfo   *DesktopMainProcess `json:"processInfo,omitempty"`
}

// DesktopMainProcess contains no argv, environment or account credentials.
type DesktopMainProcess struct {
	PID            int    `json:"pid"`
	Name           string `json:"name"`
	ExecutablePath string `json:"executablePath"`
}

var (
	errDesktopScan      = errors.New("desktop_detection_scan_failed")
	errDesktopIdentity  = errors.New("desktop_detection_identity_unavailable")
	errDesktopAmbiguous = errors.New("desktop_detection_ambiguous")
)

// DetectClaudeDesktop fixes the provider rules and platform inside the Go host.
// A successful empty scan is different from a failed or incomplete scan.
func DetectClaudeDesktop(ctx context.Context) (DesktopProcessDetection, error) {
	result := DesktopProcessDetection{Platform: runtime.GOOS, ClientName: "Claude", IdentityScope: "same_os_user_main_candidate"}
	var config *providers.DesktopPlatform
	for _, provider := range providers.BuiltinManifest().Providers {
		if provider.ID == "claude" && provider.CLI != nil && provider.CLI.DesktopClient != nil {
			switch runtime.GOOS {
			case PlatformMacOS:
				config = provider.CLI.DesktopClient.MacOS
			case PlatformWindows:
				config = provider.CLI.DesktopClient.Windows
			}
		}
	}
	if config == nil {
		result.Reason = "unsupported_platform"
		return result, nil
	}
	result.Supported = true
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	var candidates []DesktopMainProcess
	var err error
	switch runtime.GOOS {
	case PlatformMacOS:
		candidates, err = detectClaudeMac(ctx, config)
	case PlatformWindows:
		candidates, err = detectClaudeWindows(ctx, config)
	}
	if err == nil && len(candidates) > 1 {
		err = errDesktopAmbiguous
	}
	if err != nil {
		result.Reason = err.Error()
		return result, err
	}
	result.OK = true
	result.Reason = "not_running"
	if len(candidates) == 1 {
		result.Detected, result.Reason, result.ProcessInfo = true, "", &candidates[0]
	}
	return result, nil
}

// Bound stdout even if the OS command misbehaves; stderr and raw rows stay private.
type desktopScanOutput struct{ bytes.Buffer }

func (output *desktopScanOutput) Write(data []byte) (int, error) {
	if output.Len()+len(data) > 4*1024*1024 {
		return 0, errDesktopScan
	}
	return output.Buffer.Write(data)
}

func readDesktopScan(ctx context.Context, command string, args ...string) ([]byte, error) {
	var output desktopScanOutput
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Stdout, cmd.Stderr = &output, io.Discard
	if cmd.Run() != nil || ctx.Err() != nil || output.Len() == 0 {
		return nil, errDesktopScan
	}
	return output.Bytes(), nil
}

func detectClaudeMac(ctx context.Context, config *providers.DesktopPlatform) ([]DesktopMainProcess, error) {
	// ucomm is the kernel name; each candidate is rechecked with proc_info, not argv0.
	output, err := readDesktopScan(ctx, "/bin/ps", "-ww", "-axo", "pid=,ppid=,uid=,ucomm=")
	if err != nil {
		return nil, err
	}
	type row struct {
		pid, parent, uid int
		name             string
	}
	rows := make(map[int]row)
	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var ids [3]int
		for index := range ids {
			end := strings.IndexAny(line, " \t")
			if end < 1 {
				return nil, errDesktopScan
			}
			ids[index], err = strconv.Atoi(line[:end])
			if err != nil || index == 0 && ids[index] <= 0 || index == 1 && ids[index] < 0 {
				return nil, errDesktopScan
			}
			line = strings.TrimSpace(line[end:])
		}
		if _, duplicate := rows[ids[0]]; duplicate {
			return nil, errDesktopScan
		}
		rows[ids[0]] = row{ids[0], ids[1], ids[2], line}
	}
	if _, found := rows[os.Getpid()]; !found || os.Getuid() < 0 {
		return nil, errDesktopIdentity
	}
	excluded := make(map[int]bool)
	for pid := os.Getpid(); pid > 0 && !excluded[pid]; pid = rows[pid].parent {
		excluded[pid] = true
	}
	var candidates []DesktopMainProcess
	for _, process := range rows {
		if process.uid != os.Getuid() || excluded[process.pid] || !desktopExecName(config, process.name, false) {
			continue
		}
		identity, err := readDesktopProcessIdentity(ctx, process.pid)
		if err != nil || identity.PID != process.pid || identity.PPID != process.parent || identity.UID != process.uid || identity.RealUID != os.Getuid() || identity.Name != process.name {
			return nil, errDesktopIdentity
		}
		image := identity.ExecutablePath
		valid := false
		for _, marker := range config.PathIncludes {
			suffix := marker + process.name
			if strings.HasSuffix(image, suffix) && !strings.Contains(strings.TrimSuffix(image, suffix), ".app/Contents/") {
				valid = true
			}
		}
		if !valid || !validDesktopImage(image) {
			return nil, errDesktopIdentity
		}
		candidates = append(candidates, DesktopMainProcess{process.pid, process.name, image})
	}
	return candidates, nil
}

// DesktopProcessIdentity is a read-only OS fact, not account ownership.
type DesktopProcessIdentity struct {
	PID, PPID, UID, RealUID   int
	Name, ExecutablePath      string
	StartSeconds, StartMicros uint64
}

// Only the Darwin file supplies the kernel implementation; other hosts deny it.
var readDesktopProcessIdentity = func(ctx context.Context, pid int) (DesktopProcessIdentity, error) {
	return DesktopProcessIdentity{}, errDesktopIdentity
}

func validDesktopImage(image string) bool {
	if !filepath.IsAbs(image) || filepath.Clean(image) != image || strings.ContainsAny(image, "\x00\r\n\t") {
		return false
	}
	info, err := os.Stat(image)
	return err == nil && info.Mode().IsRegular() && (runtime.GOOS == PlatformWindows || info.Mode().Perm()&0111 != 0)
}

func desktopExecName(config *providers.DesktopPlatform, name string, fold bool) bool {
	for _, expected := range config.ExecNames {
		if name == expected || fold && strings.EqualFold(name, expected) {
			return true
		}
	}
	return false
}

func detectClaudeWindows(ctx context.Context, config *providers.DesktopPlatform) ([]DesktopMainProcess, error) {
	current, userErr := user.Current()
	if userErr != nil || current.Uid == "" {
		return nil, errDesktopIdentity
	}
	root := os.Getenv("SystemRoot")
	if !filepath.IsAbs(root) || filepath.Clean(root) != root {
		return nil, errDesktopScan
	}
	var names []string
	for _, name := range config.ExecNames {
		names = append(names, "'"+strings.ReplaceAll(name, "'", "''")+"'")
	}
	// Only a role flag is emitted from command line inspection, never argv itself.
	script := `$ErrorActionPreference='Stop'; $names=@(` + strings.Join(names, ",") + `);
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$all=@(Get-CimInstance Win32_Process); $anc=@{}; $p=[int]$PID;
while($p -gt 0 -and !$anc.ContainsKey($p)) { $anc[$p]=$true; $r=$all | Where-Object { [int]$_.ProcessId -eq $p } | Select-Object -First 1; if(!$r){throw 'identity'}; $p=[int]$r.ParentProcessId };
$rows=@(foreach($r in $all) { if($names -inotcontains $r.Name -or $anc.ContainsKey([int]$r.ProcessId)){continue};
$o=Invoke-CimMethod -InputObject $r -MethodName GetOwnerSid; if($o.ReturnValue -ne 0 -or !$o.Sid){throw 'owner'};
if($o.Sid -ne $sid){continue}; if(!$r.ExecutablePath -or !$r.CommandLine){throw 'image'};
$cmd=[string]$r.CommandLine; $exe=[string]$r.ExecutablePath; $quoted='"'+$exe+'"';
if($cmd.StartsWith($quoted,[StringComparison]::OrdinalIgnoreCase)){$tail=$cmd.Substring($quoted.Length)}
elseif($exe -notmatch '\s' -and $cmd.StartsWith($exe,[StringComparison]::OrdinalIgnoreCase)){$tail=$cmd.Substring($exe.Length)}
else{throw 'argv_identity'};
if(($tail.Length -gt 0 -and $tail -cnotmatch '^[ \t]') -or $tail.Contains('"') -or $tail -match '[^\S \t]|[\x00-\x08\x0a-\x1f\x7f]'){throw 'argv_shape'};
$role=''; foreach($arg in @($tail.Trim([char[]]@(32,9)) -split '[ \t]+')) {
if($arg -eq '--'){throw 'switch_terminator'};
if($arg -imatch '^(?:--|-|/)single-argument(?:=|$)'){throw 'single_argument_mode'};
if($arg -cmatch '^(?:--|-|/)type(?:=|$)') {
if($role -ne '' -or $arg -cnotmatch '^(?:--|-|/)type=([a-z][a-z0-9-]*)$'){throw 'role'};
$role=$Matches[1]; if($role -notin @('renderer','utility','gpu-process','crashpad-handler','zygote','sandbox-ipc')){throw 'role_unknown'}
} elseif($arg -imatch '^(?:--|-|/)type(?:=|$)'){throw 'role_case'}
};
@{pid=[int]$r.ProcessId;name=[string]$r.Name;executablePath=$exe;ownerSid=[string]$o.Sid;helper=[bool]($role -ne '')}
}); @{ownerSid=$sid;rows=@($rows)} | ConvertTo-Json -Compress -Depth 4`
	output, err := readDesktopScan(ctx, filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", script)
	if err != nil {
		return nil, err
	}
	var snapshot struct {
		OwnerSID string `json:"ownerSid"`
		Rows     []struct {
			PID            int    `json:"pid"`
			Name           string `json:"name"`
			ExecutablePath string `json:"executablePath"`
			OwnerSID       string `json:"ownerSid"`
			Helper         *bool  `json:"helper"`
		} `json:"rows"`
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&snapshot) != nil || snapshot.OwnerSID != current.Uid || snapshot.Rows == nil {
		return nil, errDesktopIdentity
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, errDesktopIdentity
	}
	seen := make(map[int]bool)
	var candidates []DesktopMainProcess
	for _, row := range snapshot.Rows {
		if row.PID <= 1 || row.OwnerSID != snapshot.OwnerSID || row.Helper == nil || seen[row.PID] {
			return nil, errDesktopIdentity
		}
		seen[row.PID] = true
		if *row.Helper {
			continue
		}
		if !desktopExecName(config, row.Name, true) || !desktopExecName(config, filepath.Base(row.ExecutablePath), true) || !validDesktopImage(row.ExecutablePath) {
			return nil, errDesktopIdentity
		}
		candidates = append(candidates, DesktopMainProcess{row.PID, row.Name, row.ExecutablePath})
	}
	return candidates, nil
}
