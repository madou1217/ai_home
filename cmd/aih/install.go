package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/distributioninstall"
)

const installUsage = `用法: aih install [--bin-dir DIR] [--no-service] [--json]

安装当前发行包，并注册后台服务。安装器会先备份当前版本和数据，失败时回滚。
`

// runInstallCommand 暴露发行包的产品安装器。发行包自解包后通过
// `aih install --bin-dir ~/.local/bin` 激活；缺这个入口时 install.sh 只能得到
// “未识别命令”，用户无法完成首次安装。
func runInstallCommand(ctx context.Context, arguments []string, runtime commandRuntime) error {
	flags := flag.NewFlagSet("aih install", flag.ContinueOnError)
	flags.SetOutput(runtime.stderr)
	flags.Usage = func() {
		_, _ = fmt.Fprint(runtime.stdout, installUsage)
	}
	home := flags.String("home", readEnv(runtime.lookupEnv, "AIH_HOME_DIR"), "AIH data directory")
	hostHome := flags.String("host-home", readEnv(runtime.lookupEnv, "AIH_HOST_HOME"), "host user home")
	packageRoot := flags.String("package-root", readEnv(runtime.lookupEnv, "AIH_PACKAGE_ROOT"), "complete distribution directory")
	launcher := flags.String("launcher", readEnv(runtime.lookupEnv, "AIH_EXECUTABLE"), "distribution launcher")
	binDir := flags.String("bin-dir", "", "command directory")
	noService := flags.Bool("no-service", false, "install command/data without enabling a background server")
	asJSON := flags.Bool("json", false, "print structured installation result")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unknown installation arguments")
	}
	if *packageRoot == "" {
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		*packageRoot = filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(executable))))
	}
	result, err := distributioninstall.Install(
		ctx,
		distributioninstall.Options{
			Home:        *home,
			HostHome:    *hostHome,
			PackageRoot: *packageRoot,
			Launcher:    *launcher,
			BinDir:      *binDir,
			Service:     !*noService,
			Output:      runtime.stderr,
		},
	)
	if *asJSON {
		_ = json.NewEncoder(runtime.stdout).Encode(result)
	} else if err == nil {
		_, _ = fmt.Fprintln(runtime.stdout, "AIH 已安装，可运行 aih help 或打开 WebUI。")
	}
	return err
}
