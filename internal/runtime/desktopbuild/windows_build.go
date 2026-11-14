package desktopbuild

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

func buildWindows(ctx context.Context, opts Options, root string) (LaunchSpec, error) {
	sourceDir := filepath.Join(opts.RepoRoot, "native", "translation", "windows")
	names := []string{"AihTranslation.csproj", "Program.cs", "app.manifest"}
	sourceBytes := make([][]byte, 0, len(names))
	parts := [][]byte{[]byte("go-desktop-build-v1"), []byte(opts.Mode), []byte("win-" + opts.Arch), []byte(runtime.GOOS)}
	for _, name := range names {
		raw, err := os.ReadFile(filepath.Join(sourceDir, name))
		if err != nil {
			return LaunchSpec{}, fmt.Errorf("windows_helper_source_missing: %w", err)
		}
		sourceBytes = append(sourceBytes, raw)
		parts = append(parts, raw)
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
	// Publish a source snapshot so .NET obj/restore writes never contaminate the checkout.
	sources := filepath.Join(work, "source")
	output := filepath.Join(work, "publish")
	if err := os.Mkdir(sources, 0o700); err != nil {
		return LaunchSpec{}, err
	}
	for index, name := range names {
		if err := os.WriteFile(filepath.Join(sources, name), sourceBytes[index], 0o600); err != nil {
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
	_, err = runTool(ctx, 3*time.Minute, sources, env, "dotnet", "publish", filepath.Join(sources, names[0]), "--configuration", "Release", "--runtime", "win-"+opts.Arch, "--self-contained", "true", "-p:PublishSingleFile=true", "-p:EnableCompressionInSingleFile=true", "--output", output)
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
