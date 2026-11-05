package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// main 把 status-oracle 暴露成 §7-d 双读比对的 Go 侧「一问一答」进程：
// Node 每写一行事件请求，这里读一行、跑一次状态转移、立刻回一行结果。
//
// 不整批读入再输出，是因为采集脚本要边回放真实事件边比对；长会话下等 EOF
// 会把「第几步开始不一致」的定位信息拖到整段结束。
func main() {
	if err := runOracle(os.Stdin, os.Stdout); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "status-oracle:", err)
		os.Exit(1)
	}
}

// runOracle 逐行处理 JSONL：一行请求对应一行响应，顺序与输入完全一致。
//
// 单行解析或转移失败只影响该行（见 handleOracleLine），读取循环继续消费后续行；
// 只有底层 I/O 出错才中止整个进程。
func runOracle(input io.Reader, output io.Writer) error {
	scanner := bufio.NewScanner(input)
	// runtimeState 可能带几百条按模型的记录；默认 64KiB 会把合法请求截成解析错误。
	scanner.Buffer(make([]byte, 0, 64*1024), maxOracleLineBytes)
	writer := bufio.NewWriter(output)
	encoder := json.NewEncoder(writer)
	// 不转义 < > &：Node 的 JSON.stringify 原样输出这些字符，关掉后两侧日志肉眼可 diff。
	encoder.SetEscapeHTML(false)

	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			// 空行不是请求；为它伪造一条错误响应会让下游的行号与事件序号错位。
			continue
		}
		response := handleOracleLine(line)
		if err := encoder.Encode(response); err != nil {
			return fmt.Errorf("写响应失败: %w", err)
		}
		// 每条响应立即刷出：读者按行读取时不该被缓冲卡住。
		if err := writer.Flush(); err != nil {
			return fmt.Errorf("刷新输出失败: %w", err)
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("读取请求失败: %w", err)
	}
	return nil
}
