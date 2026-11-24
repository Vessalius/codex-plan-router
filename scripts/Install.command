#!/bin/zsh
set -eu
source_dir="${0:A:h}"
cd "$source_dir"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
python_bin="${CODEX_ROUTER_PYTHON:-$(command -v python3)}"
"$python_bin" -c 'import tomllib' || { print -u2 '需要 Python 3.11 或更新版本。'; exit 1; }
destination="$HOME/.local/share/codex-plan-router"
mkdir -p -m 700 "$destination/runtime"
install -m 755 "$source_dir/runtime/node" "$destination/runtime/node.new"
mv -f "$destination/runtime/node.new" "$destination/runtime/node"
install -m 644 "$source_dir/runtime/LICENSE" "$destination/runtime/LICENSE"
CODEX_ROUTER_PYTHON="$python_bin" "$destination/runtime/node" "$source_dir/cli.mjs" install
"$python_bin" "$source_dir/menubar/install.py" "$source_dir/Codex Plan Router.app"
open "$HOME/Applications/Codex Plan Router.app" --args --settings
