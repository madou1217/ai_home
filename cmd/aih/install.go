package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/agentinstructions"
	"github.com/madou1217/ai_home/internal/runtime/completion"
	"github.com/madou1217/ai_home/internal/runtime/distributioninstall"
	"github.com/madou1217/ai_home/internal/runtime/manual"
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
	// 安装期就把各 AI 的全局指令文件接到 <hostHome>/AGENTS.md。server 启动时
	// 还会自愈一次；这里做是为了 --no-service 的安装也能立即生效。
	if err == nil {
		installHostHome := strings.TrimSpace(*hostHome)
		if installHostHome == "" {
			installHostHome = strings.TrimSpace(result.Receipt.HostHome)
		}
		ensureHostAgentInstructions(ctx, runtime, installHostHome)
	}
	// 安装成功后把命令手册落到安装目录；它不是发布包里手写的 HTML，
	// 而是由补全命令树在安装现场生成的构建产物。
	if err == nil && strings.TrimSpace(result.Receipt.Home) != "" {
		meta := manual.Meta{
			Model:       "agy/gemini-4-neon-xhigh",
			Server:      "aws",
			Version:     result.Receipt.ReleaseVersion,
			GeneratedAt: time.Now().Format("2006-01-02 15:04"),
		}
		pagePath := filepath.Join(result.Receipt.Home, "man", "aih.html")
		if pageErr := manual.Write(completion.DocumentationEntries(), completion.DocumentationGroupNotes(), meta, pagePath); pageErr != nil {
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] 命令手册生成失败（%v），可稍后运行 aih man\n", pageErr)
		}
	}
	if *asJSON {
		_ = json.NewEncoder(runtime.stdout).Encode(result)
	} else if err == nil {
		_, _ = fmt.Fprintln(runtime.stdout, "AIH 已安装，可运行 aih help 或打开 WebUI。")
	}
	return err
}

// ensureHostAgentInstructions 把各 AI 的全局指令文件统一到 <hostHome>/AGENTS.md。
// 失败只提示，不影响安装结果。
func ensureHostAgentInstructions(ctx context.Context, runtime commandRuntime, hostHome string) {
	hostHome = strings.TrimSpace(hostHome)
	if hostHome == "" {
		return
	}
	result, err := agentinstructions.Ensure(ctx, agentinstructions.Options{
		HostHome: hostHome,
		Logf: func(format string, args ...any) {
			_, _ = fmt.Fprintf(runtime.stderr, format+"\n", args...)
		},
	})
	if err != nil {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] 全局 AI 指令文件同步失败（不影响安装）："+err.Error())
		return
	}
	if len(result.Linked) > 0 || len(result.Migrated) > 0 {
		_, _ = fmt.Fprintf(
			runtime.stderr,
			"[aih] 全局 AI 指令文件已统一到 %s（链接 %d，迁移 %d）\n",
			result.Canonical, len(result.Linked), len(result.Migrated),
		)
	}
}
