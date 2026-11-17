package distributioninstall

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// Archive users may delete their download folder after installing. Copy the
// entire verified bundle to an immutable managed cache before publishing any
// launcher or service reference to it. SFX already extracts into this cache.
func stagePortableBundle(ctx context.Context, o Options, b Build) (string, error) {
	parent := filepath.Join(o.Home, "pkg")
	if err := privateDir(parent); err != nil {
		return "", err
	}
	dest := filepath.Join(parent, b.Version+"-"+b.Target+"-"+b.GoCore.SHA256[:12])
	if existing, err := ReadBuild(dest); err == nil && existing.GoCore.SHA256 == b.GoCore.SHA256 {
		return dest, nil
	}
	stage, err := os.MkdirTemp(parent, ".portable-install-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	err = filepath.WalkDir(o.PackageRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(o.PackageRoot, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(stage, rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("目录发行包包含未验证的链接，请使用单文件发行包")
		}
		if entry.IsDir() {
			return os.Mkdir(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return errors.New("目录发行包包含不支持的文件类型")
		}
		return copyFile(path, target, info.Mode().Perm())
	})
	if err != nil {
		return "", err
	}
	if _, err = ReadBuild(stage); err != nil {
		return "", err
	}
	if err = replaceFile(stage, dest); err != nil {
		return "", err
	}
	return dest, nil
}
