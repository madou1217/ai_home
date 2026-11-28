package desktopbuild

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type stagedWindowsSource struct {
	relPath string
	data    []byte
}

func buildWindows(ctx context.Context, opts Options, root string) (LaunchSpec, error) {
	translationDir := filepath.Join(opts.RepoRoot, "native", "translation", "windows")
	clipboardDir := filepath.Join(opts.RepoRoot, "native", "clipboard", "windows")

	translationNames := []string{"AihTranslation.csproj", "Program.cs", "app.manifest"}
	staged := make([]stagedWindowsSource, 0, len(translationNames)+16)
	parts := [][]byte{[]byte("go-desktop-build-v2"), []byte(opts.Mode), []byte("win-" + opts.Arch), []byte(runtime.GOOS)}

	for _, name := range translationNames {
		rel := filepath.Join("native", "translation", "windows", name)
		raw, err := os.ReadFile(filepath.Join(translationDir, name))
		if err != nil {
			return LaunchSpec{}, fmt.Errorf("windows_helper_source_missing: %w", err)
		}
		staged = append(staged, stagedWindowsSource{relPath: rel, data: raw})
		parts = append(parts, []byte(filepath.ToSlash(rel)), raw)
	}

	entries, err := os.ReadDir(clipboardDir)
	if err != nil {
		return LaunchSpec{}, fmt.Errorf("windows_helper_source_missing: %w", err)
	}
	clipboardNames := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".cs") {
			clipboardNames = append(clipboardNames, entry.Name())
		}
	}
	sort.Strings(clipboardNames)
	if len(clipboardNames) == 0 {
		return LaunchSpec{}, fmt.Errorf("windows_helper_source_missing: no clipboard C# sources in %s", clipboardDir)
	}
	for _, name := range clipboardNames {
		rel := filepath.Join("native", "clipboard", "windows", name)
		raw, err := os.ReadFile(filepath.Join(clipboardDir, name))
		if err != nil {
			return LaunchSpec{}, fmt.Errorf("windows_helper_source_missing: %w", err)
		}
		staged = append(staged, stagedWindowsSource{relPath: rel, data: raw})
		parts = append(parts, []byte(filepath.ToSlash(rel)), raw)
	}

	fingerprint := hashBytes(parts...)
	parent := filepath.Join(root, "windows", opts.Mode)
	if err := mkdirWithin(root, parent); err != nil {
		return LaunchSpec{}, err
	}
	target := filepath.Join(parent, fingerprint)
	executable := filepath.Join(target, "aih-translation.exe")
	if cachedArtifact(target, fingerprint, "aih-translation.exe") {
		if err := verifyWindowsExecutable(executable, opts.Arch); err == nil {
			return LaunchSpec{File: executable, Args: []string{}}, nil
		}
	}
	work, err := os.MkdirTemp(parent, ".windows-build-")
	if err != nil {
		return LaunchSpec{}, err
	}
	defer os.RemoveAll(work)
	// Publish a source snapshot preserving relative layout (native/translation/windows + native/clipboard/windows)
	// so .NET obj/restore writes never contaminate the checkout.
	sources := filepath.Join(work, "source")
	output := filepath.Join(work, "publish")
	if err := os.Mkdir(sources, 0o700); err != nil {
		return LaunchSpec{}, err
	}
	for _, item := range staged {
		dest := filepath.Join(sources, item.relPath)
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return LaunchSpec{}, err
		}
		if err := os.WriteFile(dest, item.data, 0o600); err != nil {
			return LaunchSpec{}, err
		}
	}
	env := setEnvironment(os.Environ(), "DOTNET_CLI_TELEMETRY_OPTOUT", "1")
	env = setEnvironment(env, "DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "1")
	env = setEnvironment(env, "DOTNET_GENERATE_ASPNET_CERTIFICATE", "false")
	env = setEnvironment(env, "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", "false")
	env = setEnvironment(env, "DOTNET_NOLOGO", "1")
	// SDK first-run state, NuGet configuration and packages stay inside this AIH home.
	for name, path := range map[string]string{
		"DOTNET_CLI_HOME": filepath.Join(root, "windows", "dotnet-home"),
		"NUGET_PACKAGES":  filepath.Join(root, "windows", "nuget-packages"),
		"APPDATA":         filepath.Join(root, "windows", "build-profile", "AppData", "Roaming"),
		"LOCALAPPDATA":    filepath.Join(root, "windows", "build-profile", "AppData", "Local"),
	} {
		if err := mkdirWithin(root, path); err != nil {
			return LaunchSpec{}, err
		}
		env = setEnvironment(env, name, path)
	}
	projectDir := filepath.Join(sources, "native", "translation", "windows")
	projectFile := filepath.Join(projectDir, "AihTranslation.csproj")
	_, err = runTool(ctx, 5*time.Minute, projectDir, env, "dotnet", "publish", projectFile, "--configuration", "Release", "--runtime", "win-"+opts.Arch, "--self-contained", "true", "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true", "-p:EnableCompressionInSingleFile=true", "--output", output)
	if err != nil {
		return LaunchSpec{}, fmt.Errorf("windows_helper_build_unavailable: %w", err)
	}
	if err := verifyWindowsExecutable(filepath.Join(output, "aih-translation.exe"), opts.Arch); err != nil {
		return LaunchSpec{}, err
	}
	if err := writeArtifactStamp(output, fingerprint, "aih-translation.exe"); err != nil {
		return LaunchSpec{}, err
	}
	if err := publishDirectory(output, target); err != nil {
		return LaunchSpec{}, err
	}
	return LaunchSpec{File: executable, Args: []string{}}, nil
}

func verifyWindowsExecutable(path, arch string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	header := make([]byte, 64)
	if _, err = io.ReadFull(file, header); err != nil || string(header[:2]) != "MZ" {
		return fmt.Errorf("windows_helper_binary_invalid")
	}
	offset := binary.LittleEndian.Uint32(header[60:64])
	if offset > 1<<20 {
		return fmt.Errorf("windows_helper_binary_invalid")
	}
	if _, err = file.Seek(int64(offset), io.SeekStart); err != nil {
		return err
	}
	signature := make([]byte, 6)
	if _, err = io.ReadFull(file, signature); err != nil || string(signature[:4]) != "PE\x00\x00" {
		return fmt.Errorf("windows_helper_binary_invalid")
	}
	expected := uint16(0x8664)
	if arch == "arm64" {
		expected = 0xaa64
	}
	if binary.LittleEndian.Uint16(signature[4:]) != expected {
		return fmt.Errorf("windows_helper_arch_mismatch")
	}
	return nil
}
