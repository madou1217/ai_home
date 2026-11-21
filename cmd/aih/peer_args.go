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
	boolean := map[string]bool{"json": true, "self": true, "unread": true, "dry-run": true, "no-envelope": true, "reset-attempts": true, "ack": true, "help": true}
	values := map[string]bool{"target": true, "provider": true, "channel": true, "mode": true, "from": true, "reply-to": true, "limit": true, "wait": true, "state": true, "subject": true, "summary": true, "purpose": true, "action": true, "reply-policy": true, "priority": true, "auto-deliver-until": true, "expires-at": true, "deadline": true, "supersedes": true}
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

const peerHelp = `aih peer — 给会话发消息，查看自己的收件箱（Go）

  aih peer [list]                     查看可用会话
  aih peer send <会话> "内容"          发送；忙或有草稿时等待
  aih peer inbox [--self]             查看收件箱，不会标记已读
  aih peer read <消息ID>              查看原文，不会标记已读
  aih peer ack <消息ID>               由收件会话确认已读
  aih peer reply <消息ID> "内容"       回复并确认原消息
  aih peer cancel|resume <消息ID>      撤回或恢复自己的待发消息
  aih peer flush                     补投就绪消息

  --subject "主题" --purpose "缘由" --action "待办"
  --priority high|normal|low      高优先级在同目标消息中先投递
  --reply-policy required|optional|none
  --reply-policy none 仅存收件箱，不打断对方。
  --json 可查看详细状态；已发送不代表对方已读。
`
