package codexruntime

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// NativeFromPrefix resolves only the official npm installation layout, not
// executable shell shims. Keeping the entire prefix preserves sibling resources.
func NativeFromPrefix(prefix string) (string, error) {
	modules := filepath.Join(prefix, "lib", "node_modules")
	if runtime.GOOS == "windows" {
		modules = filepath.Join(prefix, "node_modules")
	}
	pkg := filepath.Join(modules, "@openai", "codex")
	if !packageNamed(pkg, "@openai/codex") {
		return "", errors.New("official Codex npm package is missing")
	}
	arch, triple := "x64", "x86_64"
	if runtime.GOARCH == "arm64" {
		arch, triple = "arm64", "aarch64"
	}
	osName, suffix, executable := runtime.GOOS, "-unknown-linux-musl", "codex"
	switch runtime.GOOS {
	case "windows":
		osName, suffix, executable = "win32", "-pc-windows-msvc", "codex.exe"
	case "darwin":
		suffix = "-apple-darwin"
	case "linux":
	default:
		return "", errors.New("unsupported Codex runtime platform")
	}
	optionalName := "codex-" + osName + "-" + arch
	for _, base := range []string{filepath.Join(pkg, "node_modules"), modules} {
		optional := filepath.Join(base, "@openai", optionalName)
		if _, err := os.Lstat(optional); err == nil {
			if !packageNamed(optional, "@openai/codex", "@openai/"+optionalName) {
				return "", errors.New("official Codex platform package is invalid")
			}
			return prefixBinary(prefix, filepath.Join(optional, "vendor", triple+suffix, "bin", executable))
		}
	}
	return prefixBinary(prefix, filepath.Join(pkg, "vendor", triple+suffix, "bin", executable))
}

func prefixBinary(prefix, binary string) (string, error) {
	rel, err := filepath.Rel(prefix, binary)
	if err != nil {
		return "", err
	}
	actual, err := confinedExecutable(prefix, rel)
	if err != nil {
		return "", err
	}
	if !NativeExecutable(actual) {
		return "", errors.New("official Codex native executable is invalid")
	}
	return actual, nil
}

func packageNamed(root string, names ...string) bool {
	f, err := os.Open(filepath.Join(root, "package.json"))
	if err != nil {
		return false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil || len(data) > 65536 {
		return false
	}
	var pkg struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(data, &pkg) != nil {
		return false
	}
	for _, name := range names {
		if pkg.Name == name {
			return true
		}
	}
	return false
}

func NativeExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode()&0o111 == 0) {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var magic [4]byte
	if _, err = io.ReadFull(f, magic[:]); err != nil {
		return false
	}
	switch runtime.GOOS {
	case "windows":
		return string(magic[:2]) == "MZ"
	case "linux":
		return string(magic[:]) == "\x7fELF"
	case "darwin":
		return string(magic[:]) == "\xcf\xfa\xed\xfe" || string(magic[:]) == "\xce\xfa\xed\xfe" || string(magic[:]) == "\xca\xfe\xba\xbe" || string(magic[:]) == "\xbe\xba\xfe\xca"
	}
	return false
}
