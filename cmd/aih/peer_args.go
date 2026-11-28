package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

type peerArguments struct {
	verb        string
	positionals []string
	values      map[string]string
	flags       map[string]bool
}

func parsePeerArguments(args []string) (peerArguments, error) {
	result := peerArguments{verb: "list", values: map[string]string{}, flags: map[string]bool{}}
	boolean := map[string]bool{"json": true, "dry-run": true, "no-envelope": true, "help": true}
	values := map[string]bool{"provider": true, "channel": true, "mode": true, "from": true, "reply-to": true, "wait": true, "subject": true, "summary": true, "purpose": true, "action": true, "reply-policy": true, "priority": true, "auto-deliver-until": true, "expires-at": true, "deadline": true, "supersedes": true, "model": true, "effort": true}
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		result.verb = args[0]
		args = args[1:]
	}
	literal := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" && !literal {
			literal = true
			continue
		}
		if literal || !strings.HasPrefix(arg, "-") {
			result.positionals = append(result.positionals, arg)
			continue
		}
		if arg == "-h" {
			result.flags["help"] = true
			continue
		}
		flag, value, hasValue := strings.Cut(strings.TrimPrefix(arg, "--"), "=")
		if boolean[flag] && !hasValue {
			result.flags[flag] = true
			continue
		}
		if !values[flag] {
			return result, fmt.Errorf("未知 peer 参数：%s", arg)
		}
		if !hasValue {
			i++
			if i >= len(args) {
				return result, fmt.Errorf("--%s 缺少值", flag)
			}
			value = args[i]
		}
		result.values[flag] = value
	}
	if result.flags["help"] || result.verb == "help" {
		result.verb = "help"
	}
	return result, nil
}

func peerTime(value string) (*int64, error) {
	if value == "" {
		return nil, nil
	}
	if value == "0" {
		zero := int64(0)
		return &zero, nil
	}
	if at, err := strconv.ParseInt(value, 10, 64); err == nil && at > 0 {
		return &at, nil
	}
	at, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil, fmt.Errorf("时间需为 RFC3339 或毫秒时间戳：%s", value)
	}
	ms := at.UnixMilli()
	if ms < 0 {
		return nil, fmt.Errorf("时间不能早于 Unix epoch")
	}
	return &ms, nil
}

const peerHelp = `aih peer — 给会话直接发消息（Go）

  aih peer [list]                     查看可用会话
  aih peer send <会话> "内容"          发送；忙或有草稿时等待
  aih peer reply <消息ID> "内容"       回复该消息的发送会话
  aih peer flush                     补投仍在等待窗口内的消息

  没有收件箱、已读或归档概念：投递失败会在自动窗口内重试，
  过期后消息终止，不保留为待查阅邮件。

  --subject "主题" --purpose "缘由" --action "待办"
  --model <模型> --effort <档位>  仅 webui-chat 目标：本轮回合的模型与推理强度（其它通道随会话启动确定）
  --priority high|normal|low      高优先级在同目标消息中先投递
  --reply-policy required|optional
  --json 可查看详细状态。
`
