#!/bin/zsh
set -eu
task_source_dir="${0:A:h}"
task_build_dir="${1:-/private/tmp/codex-plan-router-menubar-build}"
task_app_path="$task_build_dir/Codex Plan Router.app"
mkdir -p "$task_app_path/Contents/MacOS" "$task_app_path/Contents/Resources" "$task_build_dir/module-cache"
task_arch="${MACOS_TARGET_ARCH:-$(uname -m)}"
[[ "$task_arch" == arm64 || "$task_arch" == x86_64 ]] || exit 2
xcrun swiftc -target "$task_arch-apple-macos13.0" -swift-version 5 -O -parse-as-library -module-cache-path "$task_build_dir/module-cache" "$task_source_dir/RouterMenu.swift" -framework AppKit -o "$task_app_path/Contents/MacOS/RouterMenu"
cp "$task_source_dir/Router.icns" "$task_app_path/Contents/Resources/Router.icns"
cat > "$task_app_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.sun.codex-plan-router.menubar</string>
<key>CFBundleName</key><string>Codex Plan Router</string>
<key>CFBundleDisplayName</key><string>Codex 多账号代理</string>
<key>CFBundleExecutable</key><string>RouterMenu</string>
<key>CFBundleIconFile</key><string>Router.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.7.4</string>
<key>CFBundleVersion</key><string>14</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>本机 Codex 多账号代理菜单栏工具</string>
</dict></plist>
PLIST
/usr/bin/plutil -lint "$task_app_path/Contents/Info.plist"
/usr/bin/codesign --force --sign - "$task_app_path"
printf '%s\n' "$task_app_path"
