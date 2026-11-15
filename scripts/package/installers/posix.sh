#!/bin/sh
# 把这份便携版安装到用户目录，并在 PATH 里放一个 aih 链接。
set -e

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VERSION="__AIH_VERSION__"
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
INSTALL_DIR=${AIH_INSTALL_DIR:-$DATA_HOME/aih}
BIN_DIR=${AIH_BIN_DIR:-$HOME/.local/bin}
NO_PATH=0
PRESERVE_EXISTING=0

usage() {
  cat <<'EOF'
用法: ./install.sh [选项]

  --prefix DIR    安装目录（默认 $XDG_DATA_HOME/aih 或 ~/.local/share/aih）
  --bin-dir DIR   放 aih 链接的目录（默认 ~/.local/bin）
  --no-path       不提示 PATH 配置
  --preserve-existing  升级无归属收据的旧安装：完整保留旧目录，不删除
  --uninstall     卸载：删除链接和安装目录
  -h, --help      显示帮助
EOF
}

UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || { echo "[aih] --prefix requires a directory" >&2; exit 2; }; INSTALL_DIR=$2; shift 2 ;;
    --bin-dir) [ "$#" -ge 2 ] && [ -n "$2" ] && [ "${2#--}" = "$2" ] || { echo "[aih] --bin-dir requires a directory" >&2; exit 2; }; BIN_DIR=$2; shift 2 ;;
    --no-path) NO_PATH=1; shift ;;
    --preserve-existing) PRESERVE_EXISTING=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[aih] 未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

fail() { echo "[aih] $*" >&2; exit 1; }

# Resolve existing ancestors without creating or deleting anything. Reject an
# installation symlink rather than following it during a destructive operation.
canonical_dir() (
  case "$1" in /*) value=$1 ;; *) value="$PWD/$1" ;; esac
  if [ -d "$value" ]; then CDPATH= cd -- "$value" && pwd -P; return; fi
  parent=$(dirname -- "$value")
  base=$(basename -- "$value")
  [ "$parent" != "$value" ] || return 1
  resolved=$(canonical_dir "$parent") || return 1
  case "$base" in .) printf '%s\n' "$resolved" ;; ..) dirname -- "$resolved" ;; *) printf '%s/%s\n' "${resolved%/}" "$base" ;; esac
)

[ ! -L "$INSTALL_DIR" ] || fail "Refusing an installation directory symlink"
INSTALL_DIR=$(canonical_dir "$INSTALL_DIR") || fail "Invalid install directory"
BIN_DIR=$(canonical_dir "$BIN_DIR") || fail "Invalid bin directory"
HOST_HOME=$(canonical_dir "$HOME") || fail "Invalid HOME"
STATE_HOME=$(canonical_dir "${AIH_HOME_DIR:-$HOME/.ai_home}") || fail "Invalid data directory"
case "$INSTALL_DIR" in /|"$HOST_HOME"|"$STATE_HOME"|"$STATE_HOME"/*) fail "Refusing root, HOME or AIH data directory" ;; esac
case "$HOST_HOME/" in "$INSTALL_DIR/"*) fail "Refusing ancestor of HOME" ;; esac
case "$STATE_HOME/" in "$INSTALL_DIR/"*) fail "Refusing ancestor of AIH data" ;; esac
case "$BIN_DIR/" in "$INSTALL_DIR/"*) fail "Bin directory must be outside the installation" ;; esac
LINK="$BIN_DIR/aih"
MARKER="$INSTALL_DIR/.aih-install-owner"
owned_install() {
  [ -f "$MARKER" ] && [ ! -L "$MARKER" ] &&
    [ "$(sed -n '1p' "$MARKER")" = 'aih-owned-install-v1' ] &&
    [ "$(sed -n '2p' "$MARKER")" = "$INSTALL_DIR" ]
}
owned_link() { [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$INSTALL_DIR/aih" ]; }
if [ "$UNINSTALL" = "1" ]; then
  if [ ! -e "$INSTALL_DIR" ]; then echo "[aih] 安装目录不存在，无需卸载"; exit 0; fi
  owned_install || fail "Refusing to remove an unowned installation; missing or mismatched ownership receipt"
  if owned_link; then rm -f -- "$LINK"; fi
  rm -rf -- "$INSTALL_DIR"
  printf '[aih] 已卸载（%s）；用户数据保留\n' "$INSTALL_DIR"
  exit 0
fi

# Never move/replace arbitrary directories or another program's aih command.
case "$SELF_DIR/" in "$INSTALL_DIR/"*) fail "Install target contains the source bundle" ;; esac
case "$INSTALL_DIR/" in "$SELF_DIR/"*) fail "Install target must be outside the source bundle" ;; esac
if [ -e "$INSTALL_DIR" ]; then
  [ -d "$INSTALL_DIR" ] || fail "Install target is not a directory"
  if [ -n "$(ls -A "$INSTALL_DIR")" ] && ! owned_install; then
    [ "$PRESERVE_EXISTING" = 1 ] || fail "Existing directory has no matching AIH ownership receipt; use --preserve-existing to move it aside without deleting"
  fi
fi
if [ -e "$LINK" ] || [ -L "$LINK" ]; then owned_link || fail "Existing aih command is not owned by this installation"; fi

if [ ! -x "$SELF_DIR/aih" ]; then
  echo "[aih] 这不是完整的安装包：找不到 $SELF_DIR/aih" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$(dirname -- "$INSTALL_DIR")"
STAGE=$(mktemp -d "${INSTALL_DIR}.new.XXXXXX")
BACKUP=''
PUBLISHED=0
cleanup_install() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$PUBLISHED" = 0 ] && [ -n "$BACKUP" ] && [ -d "$BACKUP/app" ] && [ ! -e "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ]; then
    if mv "$BACKUP/app" "$INSTALL_DIR"; then rmdir "$BACKUP"; else printf '[aih] 恢复失败，旧目录保留于 %s/app\n' "$BACKUP" >&2; fi
  fi
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi
  exit "$code"
}
# STAGE is exclusively created by this invocation; never remove predictable PID paths.
trap cleanup_install EXIT
trap 'exit 130' HUP INT TERM
cp -R "$SELF_DIR"/. "$STAGE"/
rm -f -- "$STAGE/.aih-install-owner"
printf 'aih-owned-install-v1\n%s\n' "$INSTALL_DIR" > "$STAGE/.aih-install-owner"
chmod 600 "$STAGE/.aih-install-owner"
if [ -e "$INSTALL_DIR" ]; then
  BACKUP=$(mktemp -d "${INSTALL_DIR}.old.XXXXXX")
  mv "$INSTALL_DIR" "$BACKUP/app"
  if ! mv "$STAGE" "$INSTALL_DIR"; then
    mv "$BACKUP/app" "$INSTALL_DIR"
    rmdir "$BACKUP"
    fail "安装失败，已恢复原目录"
  fi
  STAGE=''
  PUBLISHED=1
  if [ "$PRESERVE_EXISTING" = 1 ]; then
    printf '[aih] 旧目录完整保留：%s/app\n' "$BACKUP"
  else
    rm -rf -- "$BACKUP"
  fi
else
  mv "$STAGE" "$INSTALL_DIR"
  STAGE=''
  PUBLISHED=1
fi

if [ -e "$LINK" ] || [ -L "$LINK" ]; then owned_link || fail "aih command changed during installation"; fi
ln -sfn "$INSTALL_DIR/aih" "$LINK"
chmod +x "$INSTALL_DIR/aih" "$INSTALL_DIR/install.sh" 2>/dev/null || true

echo "[aih] 已安装 $VERSION 到 $INSTALL_DIR"
echo "[aih] 命令：$LINK"
if [ "$NO_PATH" != "1" ]; then
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "[aih] 提示：把 $BIN_DIR 加入 PATH，例如："; echo "      export PATH=$BIN_DIR:\$PATH" ;;
  esac
fi
echo "[aih] 数据目录仍是 ~/.ai_home（可用 AIH_HOME_DIR 修改）"
