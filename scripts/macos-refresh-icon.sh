#!/usr/bin/env bash
# macOS 아이콘 캐시 갱신 — 알림 팝업/Dock 에 구 아이콘이 뜰 때
#
# 왜 필요한가:
#   알림 센터는 번들 ID(cloud.zzamjak.terminalassistance)로 아이콘을 찾는다.
#   빌드 산출물(src-tauri/target/{debug,release}/bundle/macos/*.app)은 /Applications 의
#   설치본과 번들 ID 가 같아 LaunchServices 에 같은 ID 로 여러 개가 등록된다.
#   그중 오래된 번들이 선택되면 아이콘을 교체해도 알림에는 옛 아이콘이 계속 나온다.
#
# 하는 일: 낡은 빌드 번들 제거 → LaunchServices 재등록 → 아이콘/알림 캐시 재시작.
# (빌드 번들은 재빌드로 언제든 다시 만들어진다)
set -euo pipefail

BUNDLE_ID="cloud.zzamjak.terminalassistance"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
INSTALLED_APP="/Applications/Terminal Assistance.app"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS 전용 스크립트입니다." >&2
  exit 1
fi

for d in debug release; do
  bundle_dir="$REPO_ROOT/src-tauri/target/$d/bundle"
  if [[ -d "$bundle_dir" ]]; then
    echo "· 빌드 번들 제거: target/$d/bundle"
    rm -rf "$bundle_dir"
  fi
done

# 지워진 빌드 번들·언마운트된 dmg 사본이 등록부에 남아 있으면 알림이 그쪽 아이콘을 집는다.
# 등록부를 통째로 재구축(-kill)하면 사용자의 '기본 앱으로 열기' 설정까지 초기화되므로,
# 설치본을 제외한 등록만 골라서 해제한다.
echo "· LaunchServices 에서 설치본 외 등록 해제"
while IFS= read -r app; do
  [[ -n "$app" ]] || continue
  [[ "$app" == "$INSTALLED_APP" ]] && continue
  "$LSREGISTER" -u "$app" >/dev/null 2>&1 || true
done < <("$LSREGISTER" -dump 2>/dev/null \
  | awk -F'path: *' '/^path:.*Terminal Assistance.*\.app/{sub(/ \(0x[0-9a-f]+\)$/,"",$2); print $2}' \
  | sort -u)

if [[ -d "$INSTALLED_APP" ]]; then
  "$LSREGISTER" -f "$INSTALLED_APP" >/dev/null 2>&1 || true
else
  echo "  (설치본이 없습니다: $INSTALLED_APP)" >&2
fi

echo "· 아이콘/알림 캐시 재시작"
rm -rf "$HOME/Library/Caches/com.apple.iconservices.store" 2>/dev/null || true
killall iconservicesagent >/dev/null 2>&1 || true
killall usernoted >/dev/null 2>&1 || true
killall NotificationCenter >/dev/null 2>&1 || true
killall Dock >/dev/null 2>&1 || true

echo
echo "✓ 완료. 남은 등록:"
"$LSREGISTER" -dump 2>/dev/null | grep -E "^path:.*Terminal Assistance" | sort -u || true
echo
echo "그래도 옛 아이콘이 보이면 앱을 완전히 종료하고 다시 실행하세요."
