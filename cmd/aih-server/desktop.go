package main

import (
	"context"
	"errors"
	"flag"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/desktopbuild"
	"github.com/madou1217/ai_home/internal/runtime/desktoplauncher"
	"github.com/madou1217/ai_home/internal/runtime/desktoptranslation"
)

func runDesktopTranslation(args []string) error {
	flags := flag.NewFlagSet("aih-server __desktop-translation", flag.ContinueOnError)
	home := flags.String("home", os.Getenv("AIH_HOME_DIR"), "isolated AIH data directory")
	repo := flags.String("repo", "", "native source repository")
	protocolOnly := flags.Bool("protocol-only", false, "native JSONL only, no desktop capture or UI")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("desktop_arguments_invalid")
	}
	if *home == "" {
		root, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		*home = filepath.Join(root, ".ai_home")
	}
	if *repo == "" {
		starts := []string{}
		if executable, err := os.Executable(); err == nil {
			starts = append(starts, filepath.Dir(executable))
		}
		if cwd, err := os.Getwd(); err == nil {
			starts = append(starts, cwd)
		}
		for _, start := range starts {
			dir := start
			for depth := 0; depth < 8; depth++ {
				if _, err := os.Stat(filepath.Join(dir, "native", "translation", "main.swift")); err == nil {
					*repo = dir
					break
				}
				next := filepath.Dir(dir)
				if next == dir {
					break
				}
				dir = next
			}
			if *repo != "" {
				break
			}
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return desktoptranslation.RunFullApp(ctx, *home, func(ctx context.Context) (desktoplauncher.LaunchSpec, error) {
		spec, err := desktopbuild.Build(ctx, desktopbuild.Options{AIHomeDir: *home, RepoRoot: *repo, Mode: "full-app", ProtocolOnly: *protocolOnly, Register: runtime.GOOS == "darwin" && !*protocolOnly})
		return desktoplauncher.LaunchSpec{File: spec.File, Args: spec.Args, Env: spec.Env}, err
	}, *protocolOnly)
}
