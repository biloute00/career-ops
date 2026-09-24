#!/bin/bash
# career-ops — SessionStart hook for Claude Code on the web.
# Installs dependencies, makes Node scripts use the egress proxy, maps the
# Playwright Chromium revision to the preinstalled browser, and checks that the
# job-board APIs used by scan/discover are reachable. Never fails the session.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0
ENV_FILE="${CLAUDE_ENV_FILE:-/dev/null}"

# 1. Dependencies. --ignore-scripts skips the postinstall browser download,
#    which the sandbox blocks; Chromium is preinstalled under /opt/pw-browsers.
npm install --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 \
  || echo "career-ops setup: npm install failed; run it manually if a script reports a missing package."

# 2. Node's fetch() ignores HTTPS_PROXY unless told otherwise. The proxy agent
#    prints an "experimental" warning on stderr, which breaks scripts and tests
#    that expect a clean stderr, so silence that one warning.
echo 'export NODE_USE_ENV_PROXY=1' >> "$ENV_FILE"
echo 'export NODE_OPTIONS="${NODE_OPTIONS:-} --disable-warning=UNDICI-EHPA"' >> "$ENV_FILE"

# 3. Playwright expects a specific Chromium revision; point it at the installed one.
BROWSERS=/opt/pw-browsers
BJSON=$(ls node_modules/playwright-core/browsers.json node_modules/playwright/node_modules/playwright-core/browsers.json 2>/dev/null | head -1)
WANT=$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).browsers;console.log(b.find(x=>x.name==="chromium").revision)' "$BJSON" 2>/dev/null || true)
if [ -n "$WANT" ] && [ -d "$BROWSERS" ] && [ ! -d "$BROWSERS/chromium-$WANT" ]; then
  HAVE_FULL=$(ls -d "$BROWSERS"/chromium-[0-9]* 2>/dev/null | sort -V | tail -1)
  HAVE_SHELL=$(ls -d "$BROWSERS"/chromium_headless_shell-[0-9]* 2>/dev/null | sort -V | tail -1)
  SHIM="$HOME/.cache/career-ops/pw-browsers"
  mkdir -p "$SHIM"
  if [ -x "$HAVE_FULL/chrome-linux/chrome" ]; then
    mkdir -p "$SHIM/chromium-$WANT"
    ln -sfn "$HAVE_FULL/chrome-linux" "$SHIM/chromium-$WANT/chrome-linux64"
    touch "$SHIM/chromium-$WANT/INSTALLATION_COMPLETE" "$SHIM/chromium-$WANT/DEPENDENCIES_VALIDATED"
  fi
  if [ -x "$HAVE_SHELL/chrome-linux/headless_shell" ]; then
    mkdir -p "$SHIM/chromium_headless_shell-$WANT/chrome-headless-shell-linux64"
    ln -sfn "$HAVE_SHELL/chrome-linux/headless_shell" \
      "$SHIM/chromium_headless_shell-$WANT/chrome-headless-shell-linux64/chrome-headless-shell"
    touch "$SHIM/chromium_headless_shell-$WANT/INSTALLATION_COMPLETE" \
      "$SHIM/chromium_headless_shell-$WANT/DEPENDENCIES_VALIDATED"
  fi
  echo "export PLAYWRIGHT_BROWSERS_PATH=\"$SHIM\"" >> "$ENV_FILE"
fi

# 3b. Chromium ignores the system CA store and reads its own NSS database, so it
#     rejects the proxy's TLS certificate. Trust the locally added CAs there.
if [ -d /usr/local/share/ca-certificates ]; then
  command -v certutil >/dev/null 2>&1 \
    || timeout 120 apt-get install -y -q libnss3-tools >/dev/null 2>&1 || true
  if command -v certutil >/dev/null 2>&1; then
    NSS="$HOME/.pki/nssdb"
    mkdir -p "$NSS"
    [ -f "$NSS/cert9.db" ] || certutil -d "sql:$NSS" -N --empty-password 2>/dev/null
    CADIR=$(mktemp -d)
    node -e '
      const fs=require("fs"),path=require("path");const dir="/usr/local/share/ca-certificates";let n=0;
      for(const f of fs.readdirSync(dir).filter(f=>f.endsWith(".crt")))
        for(const p of (fs.readFileSync(path.join(dir,f),"utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[]))
          fs.writeFileSync(path.join(process.argv[1],"ca"+(++n)+".pem"),p+"\n");' "$CADIR" 2>/dev/null
    for f in "$CADIR"/*.pem; do
      [ -f "$f" ] && certutil -d "sql:$NSS" -A -t "C,," -n "local-$(basename "$f" .pem)" -i "$f" 2>/dev/null
    done
    rm -rf "$CADIR"
  fi
fi

# 4. Job-board APIs used by scan.mjs / discover-ats.mjs / audit-portals.mjs.
#    Any HTTP answer (even 404) means reachable; no answer means the environment's
#    network policy blocks the host.
HOSTS="boards-api.greenhouse.io api.ashbyhq.com api.lever.co apply.workable.com api.smartrecruiters.com"
TMP=$(mktemp -d)
for h in $HOSTS; do
  ( code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$h/" 2>/dev/null || true)
    [ "${code:-000}" = "000" ] && echo "$h" > "$TMP/$h" ) &
done
wait
BLOCKED=$(cat "$TMP"/* 2>/dev/null | sort | tr '\n' ' ')
rm -rf "$TMP"

if [ -n "$BLOCKED" ]; then
  cat <<EOF
career-ops setup: the job-board sites below are blocked by this cloud environment's network settings, so portal scans cannot run: $BLOCKED
Tell the user once, in plain French, before running scan/discover/audit (other features keep working). Suggested message:
"Pour que je puisse chercher des offres, autorisez une fois ces sites : ouvrez le menu de l'environnement cloud (barre de titre de la session) → Modifier → Accès réseau, puis ajoutez : $BLOCKED (ou choisissez un accès plus large). Dites-moi quand c'est fait."
EOF
fi

exit 0
