# cwd is the already validated canonical workspace root. Do not read content
# through links. Explicit file operations may still follow safe internal links.
pattern=$1 maximum=$2 skip_ignored=${3-0} per_file=${4-0}
if command -v rg >/dev/null 2>&1; then
  if [ "$per_file" -gt 0 ]; then
    rg --no-config --no-follow -n --no-heading --color never -m "$per_file" -e "$pattern" . | head -n "$maximum"
  else
    rg --no-config --no-follow -n --no-heading --color never -e "$pattern" . | head -n "$maximum"
  fi
else
  if [ "$skip_ignored" = 1 ]; then
    find -P . \( -name .git -o -name node_modules \) -prune -o -type f -exec grep -InH -e "$pattern" {} + | head -n "$maximum"
  else
    find -P . -type f -exec grep -nH -e "$pattern" {} + | head -n "$maximum"
  fi
fi
