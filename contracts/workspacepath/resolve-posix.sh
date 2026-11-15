# Shared remote POSIX path contract. Run with sh, never the user's login shell.
# Arguments: configured root, normalized relative path, read|replace|remove.
# Success: canonical root NUL canonical referent NUL operation path NUL.
# This is observed-path containment, NOT an atomic filesystem sandbox.
root=$1 rel=$2 mode=$3 expected=${4-}
fail() { printf 'AIH_PATH:%s\n' "$1" >&2; exit 73; }
physical_dir() (
  CDPATH=; export CDPATH
  [ ! -d "$1" ] || [ -x "$1" ] || fail permission_denied
  cd -P "$1" 2>/dev/null || fail path_query_failed
  p=$(pwd -P; r=$?; printf .; exit "$r") || fail path_query_failed
  p=${p%.}; p=${p%?}
  printf '%s' "$p"
)
# GNU/BSD readlink -n preserves exact targets; some BSD implementations do not
# append another newline when a target already ends in one. Never trim a byte.
canonical() (
  pending=$1 allow_missing=$2 current=$3 links=0 missing=0
  while [ -n "$pending" ]; do
    case $pending in /*) pending=${pending#/}; continue;; esac
    case $pending in */*) part=${pending%%/*}; pending=${pending#*/};; *) part=$pending; pending=;; esac
    case $part in ''|.) continue;; ..)
      current=${current%/*}; [ -n "$current" ] || current=/
      [ "$missing" -eq 0 ] || missing=$((missing - 1))
      continue;; esac
    candidate=${current%/}/$part
    if [ "$missing" -gt 0 ]; then
      current=$candidate; missing=$((missing + 1)); continue
    fi
    if [ -L "$candidate" ]; then
      links=$((links + 1)); [ "$links" -le 40 ] || fail path_resolution_failed
      # A dangling, looping or inaccessible link is never an ordinary new path.
      [ -e "$candidate" ] || fail path_resolution_failed
      link=$(readlink -n "$candidate"; r=$?; printf .; exit "$r") || fail path_resolution_failed
      link=${link%.}
      [ -n "$link" ] || fail path_resolution_failed
      case $link in /*) current=/;; esac
      if [ -n "$pending" ]; then pending=$link/$pending; else pending=$link; fi
      continue
    fi
    if [ -d "$candidate" ]; then
      current=$(physical_dir "$candidate"; r=$?; printf .; exit "$r") || exit 73
      current=${current%.}
    elif [ -e "$candidate" ]; then
      [ -z "$pending" ] || fail not_directory
      current=$candidate
    else
      # A failed test is not proof of ENOENT. Require a searchable, readable
      # parent and a successful directory enumeration before allowing creation.
      [ -d "$current" ] || fail not_directory
      [ -x "$current" ] && [ -r "$current" ] || fail permission_denied
      # Enumerate directory entries as argv, not newline text or unexpanded
      # shell patterns (the literal filename '*' is legal on POSIX).
      known=$(find "$current/." ! -name . -prune -exec sh -c '
        wanted=$1; shift
        for item do [ "${item##*/}" != "$wanted" ] || printf x; done
      ' aih-path-entry "$part" {} +) || fail path_query_failed
      [ -z "$known" ] || fail path_query_failed
      [ "$allow_missing" = 1 ] || fail not_found
      current=$candidate; missing=1
    fi
  done
  printf '%s' "$current"
)
case $root in /*) ;; *) fail invalid_path;; esac
case $rel in /*|..|../*|*/../*|*/..) fail invalid_path;; esac
case $mode in read|replace|remove) ;; *) fail invalid_path;; esac
root_real=$(physical_dir "$root"; r=$?; printf .; exit "$r") || exit 73
root_real=${root_real%.}
[ -z "$expected" ] || [ "$root_real" = "$expected" ] || fail workspace_root_changed
inside() {
  [ "$root_real" = / ] && return 0
  case $1 in "$root_real"|"$root_real"/*) return 0;; *) fail path_outside_workspace;; esac
}
if [ -z "$rel" ]; then
  [ "$mode" = read ] || fail invalid_path
  printf '%s\000%s\000%s\000' "$root_real" "$root_real" "$root_real"
  exit 0
fi
case $rel in */*) parent=${rel%/*}; leaf=${rel##*/};; *) parent=; leaf=$rel;; esac
[ -n "$leaf" ] || fail invalid_path
allow=0; [ "$mode" != replace ] || allow=1
parent_real=$(canonical "$parent" "$allow" "$root_real"; r=$?; printf .; exit "$r") || exit 73
parent_real=${parent_real%.}; inside "$parent_real"
entry=${parent_real%/}/$leaf
target=$entry
if [ "$mode" != remove ]; then
  target=$(canonical "$rel" "$allow" "$root_real"; r=$?; printf .; exit "$r") || exit 73
  target=${target%.}; inside "$target"
fi
io_path=$target
# Preserve rename/unlink semantics: a replacement validates the referent but
# replaces the leaf directory entry, just like the original POSIX/SFTP writer.
[ "$mode" = read ] || io_path=$entry
printf '%s\000%s\000%s\000' "$root_real" "$target" "$io_path"
