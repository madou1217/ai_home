package sshhost

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestJoinRemotePath(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		base    string
		child   string
		dialect string
		want    string
	}{
		{name: "posix 普通拼接", base: "/home/me", child: "src", dialect: DialectPOSIX, want: "/home/me/src"},
		{name: "posix 去掉重复斜杠", base: "/home/me/", child: "/src", dialect: DialectPOSIX, want: "/home/me/src"},
		{name: "posix 空根落到 /", base: "", child: "src", dialect: DialectPOSIX, want: "/src"},
		{name: "posix 根斜杠", base: "/", child: "src", dialect: DialectPOSIX, want: "/src"},
		{name: "windows 反斜杠", base: "C:\\Users\\me", child: "src", dialect: DialectPowerShell, want: "C:\\Users\\me\\src"},
		{name: "windows 混合分隔符", base: "C:/Users/me/", child: "/src", dialect: DialectPowerShell, want: "C:/Users/me\\src"},
		{name: "windows 空根", base: "", child: "src", dialect: DialectPowerShell, want: "\\src"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := JoinRemotePath(testCase.base, testCase.child, testCase.dialect); got != testCase.want {
				t.Fatalf("JoinRemotePath() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestResolveBrowsePath(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		input   string
		home    string
		dialect string
		want    string
	}{
		{name: "空路径回家目录", input: "", home: "/home/me", dialect: DialectPOSIX, want: "/home/me"},
		{name: "空白路径回家目录", input: "   ", home: "/home/me", dialect: DialectPOSIX, want: "/home/me"},
		{name: "波浪号回家目录", input: "~", home: "/home/me", dialect: DialectPOSIX, want: "/home/me"},
		{name: "波浪号子路径", input: "~/work", home: "/home/me", dialect: DialectPOSIX, want: "/home/me/work"},
		{name: "绝对路径原样", input: "/var/tmp", home: "/home/me", dialect: DialectPOSIX, want: "/var/tmp"},
		{name: "相对路径按家目录展开", input: "work/demo", home: "/home/me", dialect: DialectPOSIX, want: "/home/me/work/demo"},
		{name: "家目录带尾斜杠", input: "work", home: "/home/me/", dialect: DialectPOSIX, want: "/home/me/work"},
		{name: "windows 盘符原样", input: "C:/work", home: "C:\\Users\\me", dialect: DialectPowerShell, want: "C:/work"},
		{name: "windows 相对路径", input: "work", home: "C:\\Users\\me", dialect: DialectPowerShell, want: "C:\\Users\\me\\work"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := ResolveBrowsePath(testCase.input, testCase.home, testCase.dialect); got != testCase.want {
				t.Fatalf("ResolveBrowsePath() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestParentRemotePath(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		value   string
		dialect string
		want    string
	}{
		{name: "posix 普通目录", value: "/home/me/src", dialect: DialectPOSIX, want: "/home/me"},
		{name: "posix 尾斜杠", value: "/home/me/src/", dialect: DialectPOSIX, want: "/home/me"},
		{name: "posix 一级目录", value: "/home", dialect: DialectPOSIX, want: "/"},
		{name: "posix 根", value: "/", dialect: DialectPOSIX, want: "/"},
		{name: "posix 空", value: "", dialect: DialectPOSIX, want: "/"},
		{name: "windows 普通目录", value: "C:\\Users\\me", dialect: DialectPowerShell, want: "C:\\Users"},
		{name: "windows 盘符根", value: "C:\\", dialect: DialectPowerShell, want: "C:"},
		{name: "windows 反斜杠尾", value: "C:\\Users\\me\\", dialect: DialectPowerShell, want: "C:\\Users"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if got := ParentRemotePath(testCase.value, testCase.dialect); got != testCase.want {
				t.Fatalf("ParentRemotePath() = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestNormalizeType(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"d":                  "d",
		"directory":          "d",
		"Directory":          "d",
		"l":                  "l",
		"symbolic link":      "l",
		"regular file":       "f",
		"regular empty file": "f",
		"":                   "f",
		"socket":             "f",
		" f ":                "f",
	}
	for input, want := range cases {
		input, want := input, want
		t.Run(input, func(t *testing.T) {
			t.Parallel()
			if got := NormalizeType(input); got != want {
				t.Fatalf("NormalizeType(%q) = %q, want %q", input, got, want)
			}
		})
	}
}

func TestParseListDirOutput(t *testing.T) {
	t.Parallel()
	stdout := strings.Join([]string{
		"directory\t4096\t1700000000\tsrc",
		"regular file\t12\t1700000001\tREADME.md",
		"symbolic link\t0\t0\tlink",
		"d\t0\t0\t.",
		"d\t0\t0\t..",
		"f\t3\t4\tname\twith\ttabs",
		"f\t5\t6\t",
		"",
		"f\t7\t8\twindows\r",
	}, "\n")
	entries := ParseListDirOutput(stdout)
	if len(entries) != 5 {
		t.Fatalf("ParseListDirOutput() 返回 %d 项，want 5: %#v", len(entries), entries)
	}
	if entries[0].Name != "src" || entries[0].Type != "d" || entries[0].Size != 4096 || entries[0].Mtime != 1700000000 {
		t.Fatalf("第一项解析错误: %#v", entries[0])
	}
	if entries[2].Type != "l" {
		t.Fatalf("符号链接类型 = %q, want l", entries[2].Type)
	}
	if entries[3].Name != "name\twith\ttabs" {
		t.Fatalf("含制表符的文件名 = %q", entries[3].Name)
	}
	if entries[4].Name != "windows" {
		t.Fatalf("CRLF 行文件名 = %q", entries[4].Name)
	}
}

type fakeBrowseMachine struct {
	profile    Profile
	profileErr error
	execResult ExecResult
	execErr    error
	commands   []string
	timeouts   []time.Duration
	lanes      []string
}

func (machine *fakeBrowseMachine) Profile(context.Context) (Profile, error) {
	return machine.profile, machine.profileErr
}

func (machine *fakeBrowseMachine) Exec(
	_ context.Context,
	command string,
	timeout time.Duration,
	lane string,
) (ExecResult, error) {
	machine.commands = append(machine.commands, command)
	machine.timeouts = append(machine.timeouts, timeout)
	machine.lanes = append(machine.lanes, lane)
	return machine.execResult, machine.execErr
}

func TestBrowseDirectories(t *testing.T) {
	t.Parallel()
	machine := &fakeBrowseMachine{
		profile: Profile{Home: "/home/me", Dialect: DialectPOSIX},
		execResult: ExecResult{
			Code: 0,
			Stdout: "d\t0\t0\tbeta\n" +
				"f\t1\t0\tfile.txt\n" +
				"d\t0\t0\talpha\n",
		},
	}
	result, err := BrowseDirectories(context.Background(), machine, "work", 0)
	if err != nil {
		t.Fatalf("BrowseDirectories() error = %v", err)
	}
	if result.CurrentDir != "/home/me/work" {
		t.Fatalf("CurrentDir = %q", result.CurrentDir)
	}
	if result.ParentDir != "/home/me" {
		t.Fatalf("ParentDir = %q", result.ParentDir)
	}
	if len(result.Directories) != 2 || result.Directories[0].Name != "alpha" || result.Directories[1].Name != "beta" {
		t.Fatalf("目录列表 = %#v", result.Directories)
	}
	if result.Directories[0].Path != "/home/me/work/alpha" {
		t.Fatalf("目录路径 = %q", result.Directories[0].Path)
	}
	if len(machine.commands) != 1 || !strings.Contains(machine.commands[0], "d='/home/me/work'") {
		t.Fatalf("执行命令 = %#v", machine.commands)
	}
	if machine.timeouts[0] != DefaultBrowseTimeout || machine.lanes[0] != "interactive" {
		t.Fatalf("超时/车道 = %v/%q", machine.timeouts[0], machine.lanes[0])
	}
}

func TestBrowseDirectoriesErrors(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name       string
		result     ExecResult
		execErr    error
		profileErr error
		wantCode   string
	}{
		{name: "退出码 3 表示不存在", result: ExecResult{Code: 3}, wantCode: "not_found"},
		{name: "NOENT 表示不存在", result: ExecResult{Code: 1, Stderr: "stat: NOENT"}, wantCode: "not_found"},
		{name: "权限拒绝", result: ExecResult{Code: 1, Stderr: "bash: cd: Permission denied"}, wantCode: "permission_denied"},
		{name: "access denied", result: ExecResult{Code: 1, Stderr: "Access is denied"}, wantCode: "permission_denied"},
		{name: "其他远端错误", result: ExecResult{Code: 2, Stderr: "connection reset"}, wantCode: "remote_io_error"},
		{name: "空 stderr 也有兜底文案", result: ExecResult{Code: 2}, wantCode: "remote_io_error"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			machine := &fakeBrowseMachine{
				profile:    Profile{Home: "/home/me"},
				execResult: testCase.result,
				execErr:    testCase.execErr,
				profileErr: testCase.profileErr,
			}
			_, err := BrowseDirectories(context.Background(), machine, "", 0)
			var browseErr *BrowseError
			if !errors.As(err, &browseErr) {
				t.Fatalf("error = %v, want *BrowseError", err)
			}
			if browseErr.Code != testCase.wantCode {
				t.Fatalf("code = %q, want %q", browseErr.Code, testCase.wantCode)
			}
			if browseErr.Message == "" {
				t.Fatal("错误信息为空")
			}
		})
	}
}

func TestBrowseDirectoriesPropagatesMachineError(t *testing.T) {
	t.Parallel()
	sentinel := errors.New("dial failed")
	machine := &fakeBrowseMachine{profileErr: sentinel}
	if _, err := BrowseDirectories(context.Background(), machine, "", 0); !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want sentinel", err)
	}
	execMachine := &fakeBrowseMachine{execErr: sentinel}
	if _, err := BrowseDirectories(context.Background(), execMachine, "", 0); !errors.Is(err, sentinel) {
		t.Fatalf("exec error = %v, want sentinel", err)
	}
}

func TestListDirCommand(t *testing.T) {
	t.Parallel()
	posix := ListDirCommand(DialectPOSIX, "/home/me/it's")
	if !strings.Contains(posix, "stat --printf") {
		t.Fatalf("posix 命令缺少 stat --printf: %s", posix)
	}
	if !strings.Contains(posix, "it'\\''s") {
		t.Fatalf("posix 命令未转义单引号: %s", posix)
	}
	powershell := ListDirCommand(DialectPowerShell, "C:\\Users\\me")
	if !strings.HasPrefix(powershell, "powershell -NoProfile -NonInteractive") {
		t.Fatalf("powershell 命令前缀错误: %s", powershell)
	}
	encoded := powershell[len("powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "):]
	if decoded := decodeUTF16LEBase64(t, encoded); !strings.Contains(decoded, "Get-ChildItem") {
		t.Fatalf("powershell 脚本解码错误: %q", decoded)
	}
}
