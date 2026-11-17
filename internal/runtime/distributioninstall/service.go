package distributioninstall

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const defaultServiceLabel = "com.meadeo.ai_home"

func serviceName(o Options) string {
	if filepath.Clean(o.Home) == filepath.Join(o.HostHome, ".ai_home") {
		return defaultServiceLabel
	}
	h := sha256.Sum256([]byte(filepath.Clean(o.Home)))
	return defaultServiceLabel + "." + hex.EncodeToString(h[:4])
}

type platformHooks struct{}

func serviceFiles(o Options) []string {
	switch runtime.GOOS {
	case "linux":
		return []string{filepath.Join(o.HostHome, ".config", "systemd", "user", serviceName(o)+".service")}
	case "darwin":
		return []string{filepath.Join(o.HostHome, "Library", "LaunchAgents", serviceName(o)+".plist")}
	case "windows":
		return []string{filepath.Join(o.Home, "run", "aih-server-serve.cmd"), filepath.Join(o.Home, "run", "windows-autostart-task.json")}
	}
	return nil
}
func command(ctx context.Context, name string, args ...string) ([]byte, error) {
	op, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	c := exec.CommandContext(op, name, args...)
	c.Env = os.Environ()
	raw, err := c.CombinedOutput()
	if err != nil {
		return raw, fmt.Errorf("installation service command %s failed: %w", name, err)
	}
	return raw, nil
}
func (h platformHooks) Snapshot(ctx context.Context, o Options, backup string) (serviceSnapshot, error) {
	var s serviceSnapshot
	s.DaemonPID = stoppedDaemonPID(o)
	s.GoManaged = s.DaemonPID > 0
	if receipt, err := ReadReceipt(o.Home); err == nil && receipt.Executable != "" {
		s.GoManaged = true
	}
	for _, path := range serviceFiles(o) {
		r, err := snapshotFile(path, backup)
		if err != nil {
			return s, err
		}
		s.Files = append(s.Files, r)
		if r.Exists {
			s.Installed = true
		}
	}
	switch runtime.GOOS {
	case "linux":
		raw, _ := command(ctx, "systemctl", "--user", "is-active", serviceName(o)+".service")
		s.Running = strings.TrimSpace(string(raw)) == "active"
	case "darwin":
		_, err := command(ctx, "launchctl", "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceName(o)))
		s.Running = err == nil
	case "windows":
		raw, err := command(ctx, "schtasks", "/Query", "/TN", serviceName(o), "/XML")
		if err == nil {
			s.TaskXML = string(raw)
			s.Installed = true
		}
		c := readConfig(o.Home)
		if c.readError != nil {
			return s, c.readError
		}
		s.Running = listenerPresent(c.Port)
	default:
		return s, errors.New("installation_platform_unsupported")
	}
	return s, nil
}
func (h platformHooks) Stop(ctx context.Context, o Options, s serviceSnapshot) error {
	if s.Installed {
		switch runtime.GOOS {
		case "linux":
			if _, err := command(ctx, "systemctl", "--user", "stop", serviceName(o)+".service"); err != nil && s.Running {
				return err
			}
		case "darwin":
			_, _ = command(ctx, "launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceName(o)))
		case "windows":
			// /End may kill the Go parent before it can stop Node. Stop the
			// managed daemon gracefully first; only then clear the task instance.
			if err := stopOwnedListener(ctx, o, s); err != nil {
				return err
			}
			_, _ = command(ctx, "schtasks", "/End", "/TN", serviceName(o))
			return nil
		}
	}
	return stopOwnedListener(ctx, o, s)
}
func (h platformHooks) Install(ctx context.Context, o Options) error {
	// Reuse the application's existing service installer, not the CLI composition
	// root (which would start other runtime components while an upgrade is active).
	script := `const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.argv[1],home=process.argv[2],host=process.argv[3],label=process.argv[4];
const build=require(path.join(root,'lib/cli/services/server/autostart')).createServerAutostartService;
const service=build({fs,path,spawnSync:cp.spawnSync,processObj:process,ensureDir:p=>fs.mkdirSync(p,{recursive:true}),aiHomeDir:home,hostHomeDir:host,launchdLabel:label,logFile:path.join(home,'logs/services/background-supervisor.log'),resolveStartEntryFilePath:()=>({entryFilePath:path.join(root,'bin/ai-home.js')})});
const status=service.install();if(!status||!status.installed)throw Error('service installation did not persist');`
	cmd := exec.CommandContext(ctx, bundleNode(o.PackageRoot), "-e", script, o.PackageRoot, o.Home, o.HostHome, serviceName(o))
	cmd.Env = packageEnvironment(o)
	raw, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("安装后台服务失败（%s）: %w", strings.TrimSpace(string(raw)), err)
	}
	switch runtime.GOOS {
	case "linux":
		_, err = command(ctx, "systemctl", "--user", "restart", serviceName(o)+".service")
	case "darwin":
		_, err = command(ctx, "launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/%s", os.Getuid(), serviceName(o)))
	case "windows":
		err = startWindowsService(ctx, o)
	}
	return err
}
func (h platformHooks) Restore(ctx context.Context, o Options, s serviceSnapshot) error {
	for _, r := range s.Files {
		if err := restoreFile(r); err != nil {
			return err
		}
	}
	switch runtime.GOOS {
	case "linux":
		_, _ = command(ctx, "systemctl", "--user", "daemon-reload")
		if s.Installed && s.Running {
			_, err := command(ctx, "systemctl", "--user", "restart", serviceName(o)+".service")
			return err
		}
		if !s.Installed {
			_, _ = command(ctx, "systemctl", "--user", "disable", serviceName(o)+".service")
		}
	case "darwin":
		if s.Installed && s.Running {
			_, err := command(ctx, "launchctl", "bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), serviceFiles(o)[0])
			return err
		}
	case "windows":
		if s.TaskXML != "" {
			xml := filepath.Join(o.Home, "run", "distribution-restore-task.xml")
			if err := atomicWrite(xml, []byte(s.TaskXML), 0600); err != nil {
				return err
			}
			if _, err := command(ctx, "schtasks", "/Create", "/TN", serviceName(o), "/XML", xml, "/F"); err != nil {
				return err
			}
		} else {
			_, _ = command(ctx, "schtasks", "/Delete", "/TN", serviceName(o), "/F")
		}
		if s.Running {
			c := readConfig(o.Home)
			if c.readError != nil {
				return c.readError
			}
			if !listenerPresent(c.Port) {
				// InteractiveToken /Run can acknowledge an SSH call without starting.
				// Restore the saved script through the same detached activation path.
				return startWindowsService(ctx, o)
			}
		}
	}
	return nil
}
func packageEnvironment(o Options) []string {
	root := o.PackageRoot
	nodeDir := filepath.Dir(bundleNode(root))
	override := map[string]string{"AIH_HOME_DIR": o.Home, "AIH_HOST_HOME": o.HostHome, "AIH_PACKAGED": "1", "AIH_PACKAGE_ROOT": root, "AIH_EXECUTABLE": o.Launcher, "AIH_SERVER_NODE_EXEC": bundleNode(root), "AIH_SERVER_ENTRY_FILE": filepath.Join(root, "bin", "ai-home.js"), "PATH": nodeDir + string(os.PathListSeparator) + os.Getenv("PATH")}
	env := []string{}
	for _, item := range os.Environ() {
		name, _, ok := strings.Cut(item, "=")
		if ok {
			if _, exists := override[name]; !exists {
				env = append(env, item)
			}
		}
	}
	for k, v := range override {
		env = append(env, k+"="+v)
	}
	return env
}
