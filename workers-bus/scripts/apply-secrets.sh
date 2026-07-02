#!/usr/bin/env bash
# Применяет заполненные значения из ../../ACCESS.env к Worker'у ironwrap-bus.
# Пустые значения пропускаются - можно запускать после каждого заполненного блока.
# Запуск: bash workers-bus/scripts/apply-secrets.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # -> workers-bus/

ENV_FILE="../ACCESS.env"
[ -f "$ENV_FILE" ] || { echo "Нет $ENV_FILE - сначала заполни его"; exit 1; }
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "CLOUDFLARE_API_TOKEN пуст (Блок 1) - без него секреты не применить"; exit 1; }
export CLOUDFLARE_API_TOKEN

put() { # put ИМЯ ЗНАЧЕНИЕ - пропускает пустые
  local n="$1" v="${2:-}"
  if [ -n "$v" ]; then printf '%s' "$v" | npx wrangler secret put "$n" >/dev/null && echo "OK   $n"
  else echo "skip $n (пусто)"; fi
}

# Google SA: если задан путь к json - читаем файл
if [ -z "${GOOGLE_SERVICE_ACCOUNT_JSON:-}" ] && [ -n "${GOOGLE_SA_JSON_PATH:-}" ]; then
  GOOGLE_SERVICE_ACCOUNT_JSON="$(cat "${GOOGLE_SA_JSON_PATH/#\~/$HOME}")"
fi

put JOBNIMBUS_API_KEY           "${JOBNIMBUS_API_KEY:-}"
put GOOGLE_SERVICE_ACCOUNT_JSON "${GOOGLE_SERVICE_ACCOUNT_JSON:-}"
put TWILIO_ACCOUNT_SID          "${TWILIO_ACCOUNT_SID:-}"
put TWILIO_AUTH_TOKEN           "${TWILIO_AUTH_TOKEN:-}"
put TWILIO_FROM_NUMBER          "${TWILIO_FROM_NUMBER:-}"
put QB_WEBHOOK_TOKEN            "${QB_WEBHOOK_TOKEN:-}"

echo ""
echo "Секреты применены. НЕ-секретные настройки (OWNER/BACKUP/FROM email, Shared Drive IDs)"
echo "живут в wrangler.jsonc - их вносит Claude Code следующим шагом + deploy."
