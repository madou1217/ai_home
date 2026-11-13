// Command route-ownership-manifest 生成 Node go-core 转发器与 build stamp 共用的路由归属投影。
//
// 权威定义在 contracts/routeownership；--check 供提交前校验投影是否最新。
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/contracts/routeownership"
)

func main() {
	check := flag.Bool("check", false, "只校验生成文件是否最新")
	root := flag.String("root", ".", "仓库根目录")
	flag.Parse()

	if err := run(*root, *check); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(root string, check bool) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(routeownership.Current()); err != nil {
		return fmt.Errorf("序列化路由归属合同失败: %w", err)
	}
	return syncOutput(root, "lib/generated/route-ownership.json", buffer.Bytes(), check)
}

func syncOutput(root string, relativePath string, content []byte, check bool) error {
	target := filepath.Join(root, filepath.FromSlash(relativePath))
	if check {
		current, err := os.ReadFile(target)
		if err != nil {
			return fmt.Errorf("读取生成文件失败 %s: %w", relativePath, err)
		}
		if !bytes.Equal(current, content) {
			return fmt.Errorf("生成文件已过期: %s；请运行 go generate ./contracts/routeownership", relativePath)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("创建生成目录失败 %s: %w", relativePath, err)
	}
	current, err := os.ReadFile(target)
	if err == nil && bytes.Equal(current, content) {
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("读取已有生成文件失败 %s: %w", relativePath, err)
	}
	if err := os.WriteFile(target, content, 0o644); err != nil {
		return fmt.Errorf("写入生成文件失败 %s: %w", relativePath, err)
	}
	fmt.Printf("已生成 %s\n", relativePath)
	return nil
}
