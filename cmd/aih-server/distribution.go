package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/host/distribution"
	"github.com/madou1217/ai_home/internal/runtime/distributioninstall"
	"github.com/madou1217/ai_home/internal/runtime/distributionupdate"
)

func runDistribution(args []string) error {
	flags := flag.NewFlagSet("aih install", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	home := flags.String("home", os.Getenv("AIH_HOME_DIR"), "AIH data directory (normally automatic)")
	host := flags.String("host-home", os.Getenv("AIH_HOST_HOME"), "host user home (normally automatic)")
	root := flags.String("package-root", os.Getenv("AIH_PACKAGE_ROOT"), "complete distribution directory")
	launcher := flags.String("launcher", os.Getenv("AIH_EXECUTABLE"), "distribution launcher")
	bin := flags.String("bin-dir", "", "command directory")
	noService := flags.Bool("no-service", false, "install command/data without enabling a background server")
	asJSON := flags.Bool("json", false, "print structured installation result")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unknown installation arguments")
	}
	if *root == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		*root = filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(exe))))
	}
	result, err := distributioninstall.Install(context.Background(), distributioninstall.Options{Home: *home, HostHome: *host, PackageRoot: *root, Launcher: *launcher, BinDir: *bin, Service: !*noService, Output: os.Stderr})
	if *asJSON {
		_ = json.NewEncoder(os.Stdout).Encode(result)
	} else if err == nil {
		fmt.Fprintln(os.Stdout, "AIH 已安装，可运行 aih help 或打开 WebUI。")
	}
	return err
}

func runDistributionApply(args []string) error {
	flags := flag.NewFlagSet("distribution apply", flag.ContinueOnError)
	home := flags.String("home", os.Getenv("AIH_HOME_DIR"), "data directory")
	artifact := flags.String("artifact", "", "verified download")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *home == "" || *artifact == "" {
		return errors.New("update worker input unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	return distributioninstall.ApplyVerifiedArtifact(ctx, *home, *artifact)
}

func runDistributionUpdate(args []string) error {
	flags := flag.NewFlagSet("aih update", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	check := flags.Bool("check", false, "check without installing")
	at := flags.String("at", "", "schedule installation at RFC3339 timestamp")
	timezone := flags.String("timezone", "UTC", "appointment IANA timezone")
	cancel := flags.Bool("cancel", false, "cancel pending appointment")
	confirm := flags.Bool("confirm", false, "confirm installation and restart")
	home := flags.String("home", os.Getenv("AIH_HOME_DIR"), "AIH home")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *home == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		*home = filepath.Join(h, ".ai_home")
	}
	svc, err := distribution.New(*home, "")
	if err != nil {
		return err
	}
	defer svc.Close()
	ctx, stop := context.WithTimeout(context.Background(), 90*time.Second)
	defer stop()
	var status distributionupdate.Status
	switch {
	case *cancel:
		status, err = svc.Cancel(ctx)
	case *confirm:
		if _, err = svc.Check(ctx); err != nil {
			return err
		}
		when := time.Now()
		if *at != "" {
			when, err = time.Parse(time.RFC3339, *at)
			if err != nil {
				return err
			}
		}
		status, err = svc.Schedule(ctx, when, *timezone)
	case *check:
		status, err = svc.Check(ctx)
	default:
		status = svc.Snapshot()
	}
	if err != nil {
		return err
	}
	if err = json.NewEncoder(os.Stdout).Encode(status); err != nil {
		return err
	}
	if *confirm {
		fmt.Fprintln(os.Stderr, "[aih] 已预约安装并重启；后台服务会在空闲时执行。可使用 aih update --cancel 取消尚未开始的预约。")
	}
	return nil
}
