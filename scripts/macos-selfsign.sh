#!/usr/bin/env bash
# macOS 자체서명 코드사인 도우미
#
# 왜 필요한가:
#   Tauri 는 서명 인증서가 없으면 앱을 ad-hoc(linker) 서명 상태로 남긴다.
#   ad-hoc 서명은 인증서 체인이 없어서 tccd 가 권한 기록(csreq)을 cdhash 에만 고정한다.
#   → 빌드마다 cdhash 가 바뀌므로 "전체 디스크 접근"을 허용해도 다음 빌드에서 무효화되고,
#     터미널에서 claude 가 홈 디렉터리를 훑을 때 보호 폴더별 권한 팝업이 매번 다시 뜬다.
#   자체서명 인증서로 서명하면 csreq 가 `identifier + certificate leaf` 기준이 되어
#   재빌드해도 cdhash 와 무관하게 권한이 유지된다.
#
# 사용법:
#   bash scripts/macos-selfsign.sh cert            # 인증서 생성 (최초 1회, 관리자 권한 불필요)
#   bash scripts/macos-selfsign.sh export          # CI secret 용 base64 출력
#   bash scripts/macos-selfsign.sh sign [앱경로]   # 이미 빌드된 .app 재서명
#   bash scripts/macos-selfsign.sh installed       # 자동 업데이트 후 /Applications 앱 재서명
#   bash scripts/macos-selfsign.sh build           # 서명까지 포함한 릴리즈 빌드
#   bash scripts/macos-selfsign.sh reset           # 기존 TCC 권한 기록 초기화 (재허용 전 1회)
#   bash scripts/macos-selfsign.sh verify [앱경로] # 서명·designated requirement 확인

set -euo pipefail

CERT_NAME="${TA_SIGN_IDENTITY:-Terminal Assistance Code Signing}"
BUNDLE_ID="cloud.zzamjak.terminalassistance"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
# 인증서 원본은 리포 밖(업데이터 서명 키와 같은 곳)에 둔다 — 커밋 사고 방지.
# CI 도 같은 인증서를 써야 designated requirement 가 하나로 통일된다.
P12_PATH="${TA_SIGN_P12:-$HOME/.tauri/terminalassistance-codesign.p12}"
# 비밀번호는 인증서 옆 파일에 보관한다. 고정 기본값을 쓰면 p12 가 유출됐을 때
# 개인키가 그대로 열린다.
P12_PASS_FILE="${P12_PATH%.p12}.pass"
P12_PASS="${TA_SIGN_P12_PASSWORD:-}"
if [[ -z "$P12_PASS" && -f "$P12_PASS_FILE" ]]; then
  P12_PASS="$(cat "$P12_PASS_FILE")"
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILT_APP="$REPO_ROOT/src-tauri/target/release/bundle/macos/Terminal Assistance.app"
INSTALLED_APP="/Applications/Terminal Assistance.app"
# 빌드 산출물이 없으면 설치된 앱을 대상으로 삼는다 — 자동 업데이트 직후 재서명하는 경우.
if [[ -d "$BUILT_APP" ]]; then DEFAULT_APP="$BUILT_APP"; else DEFAULT_APP="$INSTALLED_APP"; fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS 전용 스크립트입니다." >&2
  exit 1
fi

# codesign 은 인증서 이름으로 서명할 때 codeSign 정책 신뢰를 요구하지만, SHA-1 해시로
# 지정하면 신뢰 설정 없이 서명된다 → 관리자 암호가 필요 없다.
cert_hash() {
  security find-certificate -c "$CERT_NAME" -Z "$KEYCHAIN" 2>/dev/null \
    | awk '/SHA-1 hash/{print $3; exit}'
}

have_identity() {
  [[ -n "$(cert_hash)" ]]
}

cmd_cert() {
  if have_identity; then
    echo "✓ 코드사인 인증서가 이미 있습니다: $CERT_NAME"
    return 0
  fi

  # 이전 실행이 신뢰 설정 단계에서 중단됐다면 신뢰 없는 인증서가 남아 있다 → 재실행 시 중복 누적 방지.
  while security delete-certificate -c "$CERT_NAME" -t "$KEYCHAIN" >/dev/null 2>&1; do
    echo "· 신뢰 설정이 없는 기존 인증서 제거"
  done

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  # 이미 만들어 둔 인증서 파일이 있으면 재생성하지 않고 그것을 가져온다.
  # 재생성하면 leaf 해시가 바뀌어 모든 사용자의 권한이 초기화된다.
  if [[ -f "$P12_PATH" ]]; then
    echo "· 기존 인증서 파일 사용: $P12_PATH"
    security import "$P12_PATH" -k "$KEYCHAIN" -P "$P12_PASS" -A -T /usr/bin/codesign
    have_identity && { echo "✓ 준비 완료: $CERT_NAME ($(cert_hash))"; return 0; }
    echo "✗ 인증서 파일을 가져오지 못했습니다: $P12_PATH" >&2
    exit 1
  fi

  # 코드사인 용도(extendedKeyUsage=codeSigning)로 제한한 자체서명 인증서.
  # 유효기간을 길게 잡는다 — 만료되면 서명이 불가능해지고, 인증서를 새로 만들면
  # designated requirement 의 leaf 해시가 바뀌어 전체 사용자의 권한이 한 번 초기화된다.
  cat > "$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions    = ext
prompt             = no

[dn]
CN = $CERT_NAME

[ext]
basicConstraints     = critical,CA:false
keyUsage             = critical,digitalSignature
extendedKeyUsage     = critical,codeSigning
subjectKeyIdentifier = hash
EOF

  echo "· 자체서명 인증서 생성 중…"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 9999 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/cert.cnf" 2>/dev/null

  # -legacy: macOS 키체인이 읽을 수 있는 RC2/3DES 형식. OpenSSL 3 기본값은 거부된다.
  mkdir -p "$(dirname "$P12_PATH")"
  if [[ -z "$P12_PASS" ]]; then
    P12_PASS="$(openssl rand -base64 24 | tr -d '\n')"
    printf '%s' "$P12_PASS" > "$P12_PASS_FILE"
    chmod 600 "$P12_PASS_FILE"
  fi
  openssl pkcs12 -export -legacy \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$P12_PATH" -passout "pass:$P12_PASS" -name "$CERT_NAME" 2>/dev/null \
  || openssl pkcs12 -export \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$P12_PATH" -passout "pass:$P12_PASS" -name "$CERT_NAME"
  chmod 600 "$P12_PATH"
  echo "· 인증서 파일 저장: $P12_PATH  (분실 시 재발급 불가 — 백업 권장)"

  echo "· 로그인 키체인에 가져오기 (-A: codesign 이 키를 쓸 때 매번 묻지 않게)"
  security import "$P12_PATH" -k "$KEYCHAIN" -P "$P12_PASS" -A -T /usr/bin/codesign

  if have_identity; then
    echo "✓ 준비 완료: $CERT_NAME ($(cert_hash))"
  else
    echo "✗ 인증서를 키체인에서 찾을 수 없습니다." >&2
    exit 1
  fi
}

cmd_sign() {
  local app="${1:-$DEFAULT_APP}"
  if [[ ! -d "$app" ]]; then
    echo "앱 번들이 없습니다: $app" >&2
    exit 1
  fi
  local hash; hash="$(cert_hash)"
  [[ -n "$hash" ]] || { echo "인증서가 없습니다. 먼저 'cert' 를 실행하세요." >&2; exit 1; }

  # 중첩 번들(있다면)부터 안쪽→바깥쪽 순서로 서명해야 봉인이 깨지지 않는다.
  while IFS= read -r nested; do
    [[ -n "$nested" ]] || continue
    codesign --force --timestamp=none --options runtime --sign "$hash" "$nested"
  done < <(find "$app/Contents" -maxdepth 3 \( -name '*.framework' -o -name '*.dylib' -o -name '*.app' \) 2>/dev/null | sort -r)

  # 번들을 서명하면 codesign 이 Info.plist 의 CFBundleIdentifier 를 서명 식별자로 쓴다.
  # → 식별자가 빌드마다 바뀌던 terminal_assistance-<해시> 대신 고정된 번들 ID 가 된다.
  codesign --force --timestamp=none --options runtime --sign "$hash" "$app"
  echo "✓ 서명 완료: $app"
  cmd_verify "$app"
}

cmd_verify() {
  local app="${1:-$DEFAULT_APP}"
  echo "--- 서명 정보 ---"
  codesign -dv "$app" 2>&1 | grep -E 'Identifier|Signature|TeamIdentifier|Sealed|Info.plist' || true
  echo "--- designated requirement (cdhash 가 없어야 정상) ---"
  # ad-hoc 서명 상태면 designated requirement 자체가 없어 codesign 이 실패한다 → 진단 출력만 남기고 계속.
  codesign -d -r- "$app" 2>&1 | tail -1 || true
}

cmd_export() {
  [[ -f "$P12_PATH" ]] || { echo "인증서 파일이 없습니다: $P12_PATH — 먼저 'cert' 실행" >&2; exit 1; }
  # 개인키를 터미널·로그에 흘리지 않도록 파일로만 쓴다.
  local out="${P12_PATH%.p12}-secrets.txt"
  {
    echo "GitHub 리포 Settings > Secrets and variables > Actions 에 아래 값을 등록하세요."
    echo "등록 후 이 파일은 삭제하세요."
    echo
    echo "APPLE_SIGNING_IDENTITY     = $CERT_NAME"
    echo "APPLE_CERTIFICATE_PASSWORD = $P12_PASS"
    echo "KEYCHAIN_PASSWORD          = $(openssl rand -base64 18 | tr -d '\n')"
    echo
    echo "APPLE_CERTIFICATE ="
    openssl base64 -A -in "$P12_PATH"
    echo
  } > "$out"
  chmod 600 "$out"
  echo "✓ secret 값을 파일로 저장했습니다: $out"
  echo "  등록 후 삭제: rm \"$out\""
  echo
  echo "이 인증서의 leaf 해시 (designated requirement 에 박히는 공개 값): $(cert_hash)"
  echo "인증서를 교체하면 이 해시가 바뀌어 전체 사용자의 권한 허용이 1회 초기화됩니다."
}

cmd_build() {
  cmd_cert
  # Tauri 는 APPLE_SIGNING_IDENTITY 를 codesign -s 로 넘긴다 → 해시를 주면 신뢰 없이도 서명된다.
  APPLE_SIGNING_IDENTITY="$(cert_hash)" npm run --prefix "$REPO_ROOT" tauri -- build
  cmd_verify "$BUILT_APP"
}

cmd_reset() {
  # ad-hoc 시절 cdhash 에 묶인 낡은 허용 기록을 지운다. `reset All` 은 사용자 TCC db 뿐
  # 아니라 시스템 db 의 항목(전체 디스크 접근·손쉬운 사용)까지 지우므로 sudo 가 필요 없다.
  echo "· TCC 기록 초기화: $BUNDLE_ID"
  tccutil reset All "$BUNDLE_ID"

  local left
  left=$(sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
    "select count(*) from access where client='$BUNDLE_ID';" 2>/dev/null || echo "?")
  if [[ "$left" == "0" ]]; then
    echo "✓ 남은 기록 없음"
  elif [[ "$left" == "?" ]]; then
    echo "· 시스템 TCC db 를 읽을 수 없어 잔여 기록을 확인하지 못했습니다(무해)."
  else
    echo "· 시스템 db 에 $left 개가 남았습니다. sudo 로 한 번 더:" >&2
    echo "    sudo tccutil reset SystemPolicyAllFiles $BUNDLE_ID" >&2
  fi

  echo
  echo "다음 순서로 마무리하세요:"
  echo "  1) 실행 중인 Terminal Assistance 를 완전히 종료 (서명 전 프로세스는 옛 서명을 물고 있음)"
  echo "  2) 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근에서"
  echo "     남아 있는 'Terminal Assistance' 항목을 - 로 제거"
  echo "  3) 앱을 다시 실행하고 전체 디스크 접근을 한 번 허용"
}

case "${1:-all}" in
  cert)      cmd_cert ;;
  sign)      cmd_sign "${2:-}" ;;
  installed) cmd_sign "$INSTALLED_APP" ;;   # 자동 업데이트가 번들을 교체한 뒤 재서명
  verify)    cmd_verify "${2:-}" ;;
  reset)     cmd_reset ;;
  build)     cmd_build ;;
  export)    cmd_export ;;
  all)       cmd_cert; cmd_sign "${2:-}" ;;
  *) echo "사용법: $0 {cert|sign|installed|build|export|verify|reset|all} [앱경로]" >&2; exit 1 ;;
esac
