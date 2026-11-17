package distributionupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/distributionrelease"
	"github.com/madou1217/ai_home/internal/runtime/distributionupdate/platform"
)

func hostTarget() string {
	osName, arch := runtime.GOOS, runtime.GOARCH
	if osName == "windows" {
		osName = "win32"
	}
	if arch == "amd64" {
		arch = "x64"
	}
	return osName + "-" + arch
}

func readCurrent(options Options) (CurrentInfo, error) {
	current := CurrentInfo{PackageRoot: options.PackageRoot, Source: "unknown", Target: hostTarget()}
	root, err := os.OpenRoot(options.PackageRoot)
	if err != nil {
		return current, err
	}
	defer root.Close()
	var build BuildInfo
	err = readJSON(root, "BUILD_INFO.json", 64<<10, &build, false)
	if err == nil {
		if build.Name != "ai-home" || !build.BundledUI || build.Target != hostTarget() {
			return current, fmt.Errorf("invalid or incompatible distribution build metadata")
		}
		current.Version, current.Target, current.Source, current.Build = build.Version, build.Target, "distribution", &build
	} else if errors.Is(err, os.ErrNotExist) {
		var pkg struct {
			Version string `json:"version"`
		}
		if err := readJSON(root, "package.json", 1<<20, &pkg, false); err == nil {
			current.Version, current.Source = pkg.Version, "source"
		} else if !errors.Is(err, os.ErrNotExist) {
			return current, err
		}
	} else {
		return current, err
	}
	if options.CurrentVersion != "" {
		version := strings.TrimPrefix(options.CurrentVersion, "v")
		if current.Version != "" && current.Version != version {
			return current, fmt.Errorf("current version disagrees with package metadata")
		}
		current.Version = version
	}
	if options.Target != "" && options.Target != current.Target {
		return current, fmt.Errorf("update target disagrees with current platform")
	}
	// Reuse the release module's strict current-version and target validation.
	if _, err := distributionrelease.New(distributionrelease.Options{CurrentVersion: current.Version, Target: current.Target}); err != nil {
		return current, err
	}
	return current, nil
}

func (s *Service) readInstallerReceipt(ctx context.Context) (Receipt, error) {
	if err := ctx.Err(); err != nil {
		return Receipt{}, err
	}
	root, err := os.OpenRoot(s.options.Home)
	if err != nil {
		return Receipt{}, err
	}
	defer root.Close()
	var record struct {
		Version int `json:"version"`
		Receipt
	}
	err = readJSON(root, "distribution-install.json", 64<<10, &record, true)
	if err == nil && record.Version != 1 {
		err = errors.New("unsupported native installer receipt version")
	}
	return record.Receipt, err
}

func samePath(left, right string) bool {
	if left == "" || right == "" {
		return false
	}
	left, right = filepath.Clean(left), filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

// The default verifier checks the native runtime identity (recorded at process
// startup), a live PID and the actual executable bytes against the receipt.
// No shell, remote endpoint or caller-supplied URL is used.
func (s *Service) verifyInstalledRuntime(ctx context.Context, receipt Receipt) error {
	if !digestPattern.MatchString(receipt.BinarySHA256) || !filepath.IsAbs(receipt.PackageRoot) {
		return errors.New("installer receipt lacks runtime identity")
	}
	binary := "aih-server"
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	executable := filepath.Join(receipt.PackageRoot, "bin", "native", receipt.Target, binary)
	if !samePath(executable, receipt.Executable) {
		return errors.New("installer executable does not match the distribution target")
	}
	root, err := os.OpenRoot(s.options.Home)
	if err != nil {
		return err
	}
	var identity struct {
		PID          int    `json:"pid"`
		Executable   string `json:"executable"`
		BinarySHA256 string `json:"binarySha256"`
		Home         string `json:"aiHomeDir"`
	}
	err = readJSON(root, "run/go-server-runtime.json", 64<<10, &identity, true)
	root.Close()
	if err != nil || identity.PID <= 0 || !platform.ProcessAlive(identity.PID) ||
		identity.BinarySHA256 != receipt.BinarySHA256 || !samePath(identity.Executable, executable) || !samePath(identity.Home, s.options.Home) {
		return errors.New("running server identity does not match installer receipt")
	}
	file, err := os.Open(executable)
	if err != nil {
		return err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > 1<<30 {
		return errors.New("invalid installed server executable")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, &ctxReader{ctx: ctx, reader: io.LimitReader(file, 1<<30+1)}); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != receipt.BinarySHA256 {
		return errors.New("installed executable hash does not match running server receipt")
	}
	return nil
}

type ctxReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *ctxReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
