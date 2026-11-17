package providercli

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Windows npm command shims cannot be passed to CreateProcess. Resolve only an
// installed official package layout to its native payload, without a shell or
// interpreting shim source. Existing standalone executables stay unchanged.
func resolveCodexNPMEntry(entry string) (string, error) {
	if runtime.GOOS != "windows" || codexPEFile(entry) {
		return entry, nil
	}
	root := filepath.Dir(filepath.Dir(entry))
	if !codexPackageNamed(root, "@openai/codex") {
		root = filepath.Join(filepath.Dir(entry), "node_modules", "@openai", "codex")
		if !codexPackageNamed(root, "@openai/codex") {
			return "", codexHookError(CodeCodexHookUntrusted, entry, "Codex CLI is neither a native executable nor a recognized official npm entry", nil)
		}
	}
	arch := "x64"
	triple := "x86_64-pc-windows-msvc"
	if runtime.GOARCH == "arm64" {
		arch, triple = "arm64", "aarch64-pc-windows-msvc"
	}
	packageName := "codex-win32-" + arch
	vendor := filepath.Join(root, "vendor")
	current := root
	for depth := 0; depth < 24; depth++ {
		modules := filepath.Join(current, "node_modules")
		if filepath.Base(current) == "node_modules" {
			modules = current
		}
		optional := filepath.Join(modules, "@openai", packageName)
		if _, err := os.Lstat(optional); err == nil {
			if !codexPackageNamed(optional, "@openai/codex", "@openai/"+packageName) {
				return "", codexHookError(CodeCodexHookUntrusted, entry, "Codex npm platform package is invalid", nil)
			}
			vendor = filepath.Join(optional, "vendor")
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	native, err := evalCodexHookPath(filepath.Join(vendor, triple, "bin", "codex.exe"))
	if os.IsNotExist(err) {
		return "", codexOfficialCLIMissing("")
	}
	if err != nil || !codexPEFile(native) {
		return "", codexHookError(CodeCodexHookUntrusted, entry, "Codex npm native executable is invalid", err)
	}
	return native, nil
}

func codexPEFile(path string) bool {
	if !executableFile(path) {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var magic [2]byte
	_, err = io.ReadFull(f, magic[:])
	return err == nil && string(magic[:]) == "MZ"
}

func codexPackageNamed(root string, expected ...string) bool {
	f, err := os.Open(filepath.Join(root, "package.json"))
	if err != nil {
		return false
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return false
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &pkg) != nil {
		return false
	}
	for _, name := range expected {
		if strings.TrimSpace(pkg.Name) == name {
			return true
		}
	}
	return false
}
