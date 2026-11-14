//go:build windows

package webuiserverrestartapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
)

var windowsTaskName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
var windowsServeCommand = regexp.MustCompile(`^"([^"\r\n]+)"(?:\s+"[^"\r\n]*")*(?:\s+>>\s+"([^"\r\n]+)"\s+2>&1)?$`)
var windowsRestartJobID = regexp.MustCompile(`^(?:server-restart-[a-z0-9-]{1,96}|mgmt-restart-[0-9]{1,20})$`)

type windowsTaskMarker struct {
	Task   string `json:"task"`
	Script string `json:"script"`
}

type windowsRuntimeIdentity struct {
	Version        int    `json:"version"`
	PID            int    `json:"pid"`
	AIHomeDir      string `json:"aiHomeDir"`
	Executable     string `json:"executable"`
	BinarySHA256   string `json:"binarySha256"`
	Host           string `json:"host"`
	Port           int    `json:"port"`
	ProcessStartID string `json:"processStartId"`
}

type windowsRestartPlan struct {
	JobID        string `json:"jobId"`
	Home         string `json:"home"`
	Task         string `json:"task"`
	Script       string `json:"script"`
	Marker       string `json:"marker"`
	ScriptSHA256 string `json:"scriptSha256"`
	MarkerSHA256 string `json:"markerSha256"`
	Executable   string `json:"executable"`
	OldPID       int    `json:"oldPid"`
	OldStartID   string `json:"oldStartId"`
	IdentityPath string `json:"identityPath"`
	UserSID      string `json:"userSid"`
	StatusPath   string `json:"statusPath"`
	LockPath     string `json:"lockPath"`
	CreatedAt    int64  `json:"createdAt"`
}

// readWindowsRestartPlan trusts neither a host-wide task label nor a marker alone.
// The launcher, current daemon identity and registered task are checked separately.
func readWindowsRestartPlan(aiHomeDir string, job RestartJob) (windowsRestartPlan, error) {
	if !windowsRestartJobID.MatchString(job.ID) {
		return windowsRestartPlan{}, ErrRestartUnavailable
	}
	home, err := canonicalWindowsPath(aiHomeDir)
	if err != nil {
		return windowsRestartPlan{}, ErrRestartUnavailable
	}
	runDir := filepath.Join(home, "run")
	actualRunDir, err := canonicalWindowsPath(runDir)
	if err != nil || !strings.EqualFold(actualRunDir, runDir) {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_instance_path_mismatch")
	}
	markerPath := filepath.Join(runDir, "windows-autostart-task.json")
	markerRaw, err := readWindowsMetadata(markerPath, 16*1024)
	if err != nil {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_task_metadata_unavailable")
	}
	var marker windowsTaskMarker
	decoder := json.NewDecoder(bytes.NewReader(markerRaw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&marker) != nil || !windowsTaskName.MatchString(marker.Task) {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_task_metadata_invalid")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_task_metadata_invalid")
	}
	script := filepath.Join(runDir, "aih-server-serve.cmd")
	if !sameWindowsPath(marker.Script, script) {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_task_script_mismatch")
	}
	scriptRaw, err := readWindowsMetadata(script, 64*1024)
	if err != nil {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_task_script_unavailable")
	}
	executable, err := os.Executable()
	if err != nil {
		return windowsRestartPlan{}, ErrRestartUnavailable
	}
	executable, err = canonicalWindowsPath(executable)
	if err != nil || !strings.EqualFold(filepath.Base(executable), "aih-server.exe") {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_executable_mismatch")
	}
	if err := validateWindowsServeScript(scriptRaw, home, executable); err != nil {
		return windowsRestartPlan{}, err
	}
	identityPath := filepath.Join(runDir, "go-server-runtime.json")
	identityRaw, err := readWindowsMetadata(identityPath, 16*1024)
	if err != nil {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_identity_unavailable")
	}
	var identity windowsRuntimeIdentity
	if json.Unmarshal(identityRaw, &identity) != nil || identity.Version != 1 || identity.PID != os.Getpid() ||
		!sameWindowsPath(identity.AIHomeDir, home) || !sameWindowsPath(identity.Executable, executable) || identity.Port < 1 || identity.Port > 65535 {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_identity_mismatch")
	}
	var created, exited, kernel, user windows.Filetime
	if windows.GetProcessTimes(windows.CurrentProcess(), &created, &exited, &kernel, &user) != nil ||
		identity.ProcessStartID != "windows:"+strconv.FormatInt(created.Nanoseconds()/1_000_000, 10) {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_identity_stale")
	}
	tokenUser, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return windowsRestartPlan{}, fmt.Errorf("server_restart_user_unavailable")
	}
	return windowsRestartPlan{
		JobID: job.ID, Home: home, Task: marker.Task, Script: script, Marker: markerPath,
		ScriptSHA256: windowsSHA256(scriptRaw), MarkerSHA256: windowsSHA256(markerRaw),
		Executable: executable, OldPID: identity.PID, OldStartID: identity.ProcessStartID,
		IdentityPath: identityPath, UserSID: tokenUser.User.Sid.String(), CreatedAt: job.CreatedAt,
	}, nil
}

func validateWindowsServeScript(raw []byte, home, executable string) error {
	var lines []string
	for _, line := range strings.Split(strings.TrimPrefix(string(raw), "\ufeff"), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) < 3 || len(lines) > 9 || !strings.EqualFold(lines[0], "@echo off") || !strings.EqualFold(lines[1], `set "AIH_HOME_DIR=`+home+`"`) {
		return fmt.Errorf("server_restart_launcher_home_mismatch")
	}
	// Optional host-home isolation is restricted to directories inside this same instance.
	// Never accept PATH, credentials, executable overrides or arbitrary cmd statements.
	seen := map[string]bool{}
	for _, line := range lines[2 : len(lines)-1] {
		if !strings.HasPrefix(strings.ToLower(line), `set "`) || !strings.HasSuffix(line, `"`) {
			return fmt.Errorf("server_restart_launcher_environment_unsafe")
		}
		name, value, ok := strings.Cut(line[5:len(line)-1], "=")
		name = strings.ToUpper(name)
		switch name {
		case "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP":
		default:
			return fmt.Errorf("server_restart_launcher_environment_unsafe")
		}
		resolved, err := canonicalWindowsPath(value)
		if !ok || seen[name] || err != nil || strings.ContainsAny(value, "%!^&|<>`") ||
			!strings.HasPrefix(strings.ToLower(resolved), strings.ToLower(home+string(filepath.Separator))) {
			return fmt.Errorf("server_restart_launcher_environment_unsafe")
		}
		seen[name] = true
	}
	commandLine := lines[len(lines)-1]
	match := windowsServeCommand.FindStringSubmatch(commandLine)
	if match == nil || !sameWindowsPath(match[1], executable) {
		return fmt.Errorf("server_restart_launcher_command_mismatch")
	}
	// Only the quoted native command + optional append-log redirect emitted by Node is accepted.
	// Reject cmd expansion or extra commands even inside quoted values.
	command := strings.SplitN(commandLine, " >> ", 2)[0]
	if strings.ContainsAny(command, "%!^&|<>`") || strings.ContainsAny(home, "%!^&|<>`\"\r\n") {
		return fmt.Errorf("server_restart_launcher_command_unsafe")
	}
	if match[2] != "" {
		logDir := filepath.Join(home, "logs") + string(filepath.Separator)
		if !strings.HasPrefix(strings.ToLower(filepath.Clean(match[2])), strings.ToLower(logDir)) || strings.ContainsAny(match[2], "%!^&|<>`\r\n") {
			return fmt.Errorf("server_restart_launcher_log_mismatch")
		}
	}
	return nil
}

func canonicalWindowsPath(value string) (string, error) {
	if !filepath.IsAbs(value) || filepath.VolumeName(value) == "" || strings.HasPrefix(value, `\\`) || strings.ContainsAny(value, "\"\r\n\x00") {
		return "", ErrRestartUnavailable
	}
	return filepath.EvalSymlinks(filepath.Clean(value))
}

func sameWindowsPath(left, right string) bool {
	a, errA := canonicalWindowsPath(left)
	b, errB := canonicalWindowsPath(right)
	return errA == nil && errB == nil && strings.EqualFold(a, b)
}

func readWindowsMetadata(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, ErrRestartUnavailable
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, ErrRestartUnavailable
	}
	return raw, nil
}

func windowsSHA256(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
