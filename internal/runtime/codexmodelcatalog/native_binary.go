package codexmodelcatalog

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// resolveContextNativeBinary never executes a script to discover its child.
// The official npm entry resolves an optional platform package, then vendor/.
// Execute that native payload so deadlines and cache identity share one owner.
func resolveContextNativeBinary(entry string) (string, error) {
	real, err := filepath.EvalSymlinks(entry)
	if err != nil {
		return "", errContextCatalogUnavailable
	}
	if isContextNativeBinary(real) {
		return real, nil
	}
	root := filepath.Dir(filepath.Dir(real))
	if !contextPackageNamed(root, "@openai/codex") {
		// npm's Windows command shim sits beside node_modules rather than bin/.
		root = filepath.Join(filepath.Dir(real), "node_modules", "@openai", "codex")
		if !contextPackageNamed(root, "@openai/codex") {
			return "", errContextCatalogUnavailable
		}
	}
	// Node process.arch can differ from the Go host (for example Rosetta).
	// Select from the actual installed payloads, not runtime.GOARCH. When both
	// architectures are installed, no evidence identifies the launcher's choice.
	var selected string
	for _, platform := range contextNativePlatforms() {
		candidate := contextPlatformNative(root, platform)
		if candidate == "" {
			continue
		}
		if selected != "" && selected != candidate {
			return "", errContextCatalogUnavailable
		}
		selected = candidate
	}
	if selected == "" {
		return "", errContextCatalogUnavailable
	}
	return selected, nil
}

type contextNativePlatform struct {
	triple      string
	packageName string
}

func contextPlatformNative(root string, platform contextNativePlatform) string {
	vendor := filepath.Join(root, "vendor")
	// Match Node package lookup, including nested optional dependencies and pnpm
	// links. A found-but-broken optional package must not silently pick another.
	current := root
	for depth := 0; depth < 24; depth++ {
		moduleRoot := filepath.Join(current, "node_modules")
		if filepath.Base(current) == "node_modules" {
			moduleRoot = current
		}
		candidate := filepath.Join(moduleRoot, "@openai", platform.packageName)
		// npm optional dependencies are aliases: the directory is platform-
		// qualified, but the published manifest remains @openai/codex.
		if contextPackageNamed(candidate, "@openai/codex") || contextPackageNamed(candidate, "@openai/"+platform.packageName) {
			packageFile, err := filepath.EvalSymlinks(filepath.Join(candidate, "package.json"))
			if err != nil {
				return ""
			}
			vendor = filepath.Join(filepath.Dir(packageFile), "vendor")
			break
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	executable := "codex"
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	native, err := filepath.EvalSymlinks(filepath.Join(vendor, platform.triple, "bin", executable))
	if err != nil || !isContextNativeBinary(native) {
		return ""
	}
	return native
}

func contextPackageNamed(root, expected string) bool {
	file, err := os.Open(filepath.Join(root, "package.json"))
	if err != nil {
		return false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 64*1024+1))
	if err != nil || len(data) > 64*1024 {
		return false
	}
	var manifest struct {
		Name string `json:"name"`
	}
	return json.Unmarshal(data, &manifest) == nil && manifest.Name == expected
}

func isContextNativeBinary(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0) {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	var header [4]byte
	if _, err := io.ReadFull(file, header[:]); err != nil {
		return false
	}
	magic := string(header[:])
	return magic == "\x7fELF" || strings.HasPrefix(magic, "MZ") ||
		magic == "\xcf\xfa\xed\xfe" || magic == "\xfe\xed\xfa\xcf" ||
		magic == "\xce\xfa\xed\xfe" || magic == "\xfe\xed\xfa\xce" ||
		magic == "\xca\xfe\xba\xbe" || magic == "\xbe\xba\xfe\xca" ||
		magic == "\xca\xfe\xba\xbf" || magic == "\xbf\xba\xfe\xca"
}

func contextNativePlatforms() []contextNativePlatform {
	switch runtime.GOOS {
	case "darwin":
		return []contextNativePlatform{{"aarch64-apple-darwin", "codex-darwin-arm64"}, {"x86_64-apple-darwin", "codex-darwin-x64"}}
	case "linux", "android":
		return []contextNativePlatform{{"aarch64-unknown-linux-musl", "codex-linux-arm64"}, {"x86_64-unknown-linux-musl", "codex-linux-x64"}}
	case "windows":
		return []contextNativePlatform{{"aarch64-pc-windows-msvc", "codex-win32-arm64"}, {"x86_64-pc-windows-msvc", "codex-win32-x64"}}
	default:
		return nil
	}
}
