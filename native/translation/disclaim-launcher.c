// macOS 隐私权限（辅助功能等）按「责任进程」判定：helper 由 aih 后台的 node 拉起时，
// TCC 把 node 当成责任方，用户在系统设置里给 AIH Translation 开的开关不会生效
// （node 自己被拒时 helper 一直是 permission-required）。这个小启动器用
// responsibility_spawnattrs_setdisclaim 放弃责任归属，让 helper 自己成为责任进程，
// 并把 stdin/stdout/stderr 原样继承、转发终止信号、透传退出码。
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>
extern char **environ;
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);
static pid_t child = 0;
static void forward(int sig) { if (child > 0) kill(child, sig); }
int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: disclaim <exe> [args...]\n"); return 64; }
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  responsibility_spawnattrs_setdisclaim(&attr, 1);
  int rc = posix_spawn(&child, argv[1], NULL, &attr, &argv[1], environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) { fprintf(stderr, "disclaim: spawn failed: %s\n", strerror(rc)); return 127; }
  signal(SIGTERM, forward); signal(SIGINT, forward); signal(SIGHUP, forward);
  // helper 靠 getppid()==1 判断宿主已退出；中间多了这一层后，宿主（node）退出时
  // 启动器也必须跟着退出，helper 才能看到自己被 launchd 收养。
  pid_t host = getppid();
  int status = 0;
  for (;;) {
    pid_t done = waitpid(child, &status, WNOHANG);
    if (done == child) break;
    if (getppid() != host) { kill(child, SIGTERM); waitpid(child, &status, 0); break; }
    usleep(500 * 1000);
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
}
