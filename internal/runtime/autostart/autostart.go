// Package autostart installs and removes the AI Home background service.
//
// It owns the launchd plist on macOS and the systemd user unit on Linux. The
// installed service always runs the Go aih-server directly; Node is not part of
// the service command.
package autostart

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	DefaultLabel   = "com.meadeo.ai_home"
	commandTimeout = 30 * time.Second
)

var ErrUnsupportedPlatform = errors.New("autostart_platform_unsupported")

type Options struct {
	Label        string
	Home         string
	HostHome     string
	ServerBinary string
	WebDir       string
	LogFile      string
}

type Status struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Loaded    bool   `json:"loaded"`
	File      string `json:"file,omitempty"`
	Label     string `json:"label"`
}

func normalize(options Options) (Options, error) {
	if strings.TrimSpace(options.Label) == "" {
		options.Label = DefaultLabel
	}
	if strings.TrimSpace(options.Home) == "" || strings.TrimSpace(options.HostHome) == "" {
		return options, errors.New("autostart_home_required")
	}
	home, err := filepath.Abs(options.Home)
	if err != nil {
		return options, err
	}
	hostHome, err := filepath.Abs(options.HostHome)
	if err != nil {
		return options, err
	}
	options.Home = filepath.Clean(home)
	options.HostHome = filepath.Clean(hostHome)
	server, err := filepath.Abs(strings.TrimSpace(options.ServerBinary))
	if err != nil || strings.TrimSpace(options.ServerBinary) == "" {
		return options, errors.New("autostart_server_binary_required")
	}
	options.ServerBinary = filepath.Clean(server)
	if info, err := os.Stat(options.ServerBinary); err != nil || info.IsDir() {
		return options, fmt.Errorf("autostart_server_binary_unavailable: %s", options.ServerBinary)
	}
	if strings.TrimSpace(options.WebDir) != "" {
		webDir, err := filepath.Abs(options.WebDir)
		if err != nil {
			return options, err
		}
		options.WebDir = filepath.Clean(webDir)
		if info, err := os.Stat(filepath.Join(options.WebDir, "index.html")); err != nil || info.IsDir() {
			options.WebDir = ""
		}
	}
	if strings.TrimSpace(options.LogFile) == "" {
		options.LogFile = filepath.Join(options.Home, "logs", "services", "background-supervisor.log")
	}
	return options, nil
}

func serviceArgs(options Options) []string {
	args := []string{options.ServerBinary, "--host", "127.0.0.1"}
	if options.WebDir != "" {
		args = append(args, "--web-dir", options.WebDir)
	}
	return args
}

func Install(ctx context.Context, options Options) (Status, error) {
	options, err := normalize(options)
	if err != nil {
		return Status{}, err
	}
	switch runtime.GOOS {
	case "darwin":
		return installLaunchd(ctx, options)
	case "linux":
		return installSystemd(ctx, options)
	default:
		return Status{Label: options.Label}, ErrUnsupportedPlatform
	}
}

func Uninstall(ctx context.Context, options Options) error {
	options, err := normalize(options)
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "darwin":
		return uninstallLaunchd(ctx, options)
	case "linux":
		return uninstallSystemd(ctx, options)
	default:
		return ErrUnsupportedPlatform
	}
}

func StatusFor(ctx context.Context, options Options) (Status, error) {
	options, err := normalize(options)
	if err != nil {
		return Status{}, err
	}
	switch runtime.GOOS {
	case "darwin":
		return statusLaunchd(ctx, options)
	case "linux":
		return statusSystemd(ctx, options)
	default:
		return Status{Label: options.Label}, ErrUnsupportedPlatform
	}
}

func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	op, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(op, name, args...)
	cmd.Env = os.Environ()
	raw, err := cmd.CombinedOutput()
	if err != nil {
		return raw, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".autostart-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

func xmlEscape(value string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(value))
	return buffer.String()
}

func plistPath(options Options) string {
	return filepath.Join(options.HostHome, "Library", "LaunchAgents", options.Label+".plist")
}

func launchdDomain() string {
	return fmt.Sprintf("gui/%d", os.Getuid())
}

func buildPlist(options Options) []byte {
	lines := []string{
		"<?xml version='1.0' encoding='UTF-8'?>",
		"<!DOCTYPE plist PUBLIC '-//Apple//DTD PLIST 1.0//EN' 'http://www.apple.com/DTDs/PropertyList-1.0.dtd'>",
		"<plist version='1.0'>",
		"  <dict>",
		"    <key>Label</key>",
		"    <string>" + xmlEscape(options.Label) + "</string>",
		"    <key>ProgramArguments</key>",
		"    <array>",
	}
	for _, argument := range serviceArgs(options) {
		lines = append(lines, "      <string>"+xmlEscape(argument)+"</string>")
	}
	lines = append(lines,
		"    </array>",
		"    <key>RunAtLoad</key>",
		"    <true/>",
		"    <key>KeepAlive</key>",
		"    <dict>",
		"      <key>SuccessfulExit</key>",
		"      <false/>",
		"    </dict>",
		"    <key>ExitTimeOut</key>",
		"    <integer>12</integer>",
		"    <key>ProcessType</key>",
		"    <string>Standard</string>",
		"    <key>ThrottleInterval</key>",
		"    <integer>5</integer>",
		"    <key>StandardOutPath</key>",
		"    <string>"+xmlEscape(options.LogFile)+"</string>",
		"    <key>StandardErrorPath</key>",
		"    <string>"+xmlEscape(options.LogFile)+"</string>",
		"    <key>EnvironmentVariables</key>",
		"    <dict>",
		"      <key>HOME</key>",
		"      <string>"+xmlEscape(options.HostHome)+"</string>",
		"      <key>PATH</key>",
		"      <string>"+xmlEscape(os.Getenv("PATH"))+"</string>",
		"      <key>AIH_HOME_DIR</key>",
		"      <string>"+xmlEscape(options.Home)+"</string>",
		"    </dict>",
		"  </dict>",
		"</plist>",
		"",
	)
	return []byte(strings.Join(lines, string(rune(10))))
}

func installLaunchd(ctx context.Context, options Options) (Status, error) {
	path := plistPath(options)
	domain := launchdDomain()
	target := domain + "/" + options.Label
	_, _ = run(ctx, "launchctl", "bootout", target)
	// bootout returns before launchd has always forgotten the old job. A short
	// fixed delay plus polling avoids the common Input/output error race.
	time.Sleep(time.Second)
	for attempt := 0; attempt < 50; attempt++ {
		if _, err := run(ctx, "launchctl", "print", target); err != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err := atomicWrite(path, buildPlist(options), 0600); err != nil {
		return Status{}, err
	}
	var bootstrapErr error
	for attempt := 0; attempt < 6; attempt++ {
		if _, bootstrapErr = run(ctx, "launchctl", "bootstrap", domain, path); bootstrapErr == nil {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if bootstrapErr != nil {
		// launchctl load is the legacy fallback for older launchd versions.
		if _, loadErr := run(ctx, "launchctl", "load", path); loadErr != nil {
			return Status{}, fmt.Errorf("launchctl bootstrap: %w; load: %v", bootstrapErr, loadErr)
		}
	}
	time.Sleep(time.Second)
	if _, err := run(ctx, "launchctl", "print", target); err != nil {
		return Status{}, fmt.Errorf("launchctl bootstrap: %w", bootstrapErr)
	}
	_, _ = run(ctx, "launchctl", "kickstart", "-k", target)
	return StatusFor(ctx, options)
}

func uninstallLaunchd(ctx context.Context, options Options) error {
	_, _ = run(ctx, "launchctl", "bootout", launchdDomain()+"/"+options.Label)
	if err := os.Remove(plistPath(options)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func statusLaunchd(ctx context.Context, options Options) (Status, error) {
	path := plistPath(options)
	status := Status{Supported: true, Label: options.Label, File: path}
	if _, err := os.Stat(path); err == nil {
		status.Installed = true
	}
	if _, err := run(ctx, "launchctl", "print", launchdDomain()+"/"+options.Label); err == nil {
		status.Loaded = true
	}
	return status, nil
}

func unitPath(options Options) string {
	return filepath.Join(options.HostHome, ".config", "systemd", "user", options.Label+".service")
}

func systemdQuote(value string) string {
	backslash := string(rune(92))
	quote := string(rune(34))
	value = strings.ReplaceAll(value, backslash, backslash+backslash)
	value = strings.ReplaceAll(value, quote, backslash+quote)
	value = strings.ReplaceAll(value, "%", "%%")
	return quote + value + quote
}

func buildUnit(options Options) []byte {
	args := serviceArgs(options)
	quoted := make([]string, 0, len(args))
	for _, argument := range args {
		quoted = append(quoted, systemdQuote(argument))
	}
	lines := []string{
		"[Unit]",
		"Description=AI Home local server",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		"ExecStart=" + strings.Join(quoted, " "),
		"WorkingDirectory=" + systemdQuote(filepath.Dir(options.ServerBinary)),
		"Restart=always",
		"RestartSec=5",
		"TimeoutStopSec=12",
		"Environment=" + systemdQuote("HOME="+options.HostHome),
		"Environment=" + systemdQuote("AIH_HOME_DIR="+options.Home),
		"Environment=" + systemdQuote("PATH="+os.Getenv("PATH")),
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	}
	return []byte(strings.Join(lines, string(rune(10))))
}

func installSystemd(ctx context.Context, options Options) (Status, error) {
	if _, err := run(ctx, "systemctl", "--user", "--version"); err != nil {
		return Status{}, err
	}
	if err := atomicWrite(unitPath(options), buildUnit(options), 0600); err != nil {
		return Status{}, err
	}
	if _, err := run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return Status{}, err
	}
	if _, err := run(ctx, "systemctl", "--user", "enable", options.Label+".service"); err != nil {
		return Status{}, err
	}
	if _, err := run(ctx, "systemctl", "--user", "restart", options.Label+".service"); err != nil {
		return Status{}, err
	}
	return StatusFor(ctx, options)
}

func uninstallSystemd(ctx context.Context, options Options) error {
	_, _ = run(ctx, "systemctl", "--user", "disable", "--now", options.Label+".service")
	if err := os.Remove(unitPath(options)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, _ = run(ctx, "systemctl", "--user", "daemon-reload")
	return nil
}

func statusSystemd(ctx context.Context, options Options) (Status, error) {
	path := unitPath(options)
	status := Status{Supported: true, Label: options.Label, File: path}
	if _, err := os.Stat(path); err == nil {
		status.Installed = true
	}
	if _, err := run(ctx, "systemctl", "--user", "is-active", options.Label+".service"); err == nil {
		status.Loaded = true
	}
	return status, nil
}
