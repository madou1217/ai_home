package main

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

// adoptSudoUserHome 让 sudo 启动的原生 CLI 继续使用调用者的 AIH 数据与 SSH 身份。
//
// sudo 默认把 HOME 改成 root 家目录；如果 AIH_HOME_DIR 也没显式给出，CLI 会
// 打开 /var/root/.ai_home，既找不到账号库也找不到 ~/.ssh 默认私钥。
// 只在 euid=0 且存在 SUDO_USER 时生效，不覆盖调用方显式设置。
func adoptSudoUserHome(getenv func(string) string, setenv func(string, string) error) {
	if getenv == nil || setenv == nil || os.Geteuid() != 0 {
		return
	}
	sudoUser := strings.TrimSpace(getenv("SUDO_USER"))
	if sudoUser == "" || sudoUser == "root" {
		return
	}
	account, err := user.Lookup(sudoUser)
	if err != nil || strings.TrimSpace(account.HomeDir) == "" {
		return
	}
	home := account.HomeDir
	if strings.TrimSpace(getenv("AIH_HOME_DIR")) == "" {
		candidate := filepath.Join(home, ".ai_home")
		if info, statErr := os.Stat(candidate); statErr == nil && info.IsDir() {
			_ = setenv("AIH_HOME_DIR", candidate)
		}
	}
	currentHome := strings.TrimSpace(getenv("HOME"))
	if currentHome == "" || currentHome == "/var/root" || currentHome == "/root" {
		_ = setenv("HOME", home)
	}
}
