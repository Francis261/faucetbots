#!/bin/bash
# RoseCrypto Account Manager — accounts + docker control + live logs

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1
BOT="node $SCRIPT_DIR/bot.mjs"
COMPOSE="docker compose -f $SCRIPT_DIR/docker/docker-compose.yml"
BOTLOG="$SCRIPT_DIR/bot.log"

case "$1" in
  add)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: $0 add <username> <password>"
      exit 1
    fi
    $BOT add "$2" "$3"
    ;;
  list)
    $BOT list
    ;;
  run)
    $BOT
    ;;
  # ---- docker control ----
  up)
    $COMPOSE up -d --build
    echo "Started. Watch it:  $0 logs"
    ;;
  down)
    $COMPOSE down
    ;;
  restart)
    $COMPOSE restart
    ;;
  rebuild)
    $COMPOSE up -d --build --force-recreate
    echo "Recreated. Watch it:  $0 logs"
    ;;
  status)
    $COMPOSE ps
    ;;
  # ---- logs (what's happening inside docker) ----
  logs)
    # Full container log: entrypoint messages (xvfb/vnc/bot supervision)
    # + everything the bot prints.  Ctrl-C stops tailing, container keeps running.
    $COMPOSE logs -f --tail 100
    ;;
  log)
    # The bot's own log file (mounted from the container as ./bot.log).
    # Shows per-round detail: logins, faucets, claims, errors.
    [ -f "$BOTLOG" ] || { echo "No bot.log yet — is the container running? ($0 up)"; exit 1; }
    tail -f "$BOTLOG"
    ;;
  logf)
    # Last 200 lines of the bot log, then exit.
    [ -f "$BOTLOG" ] || { echo "No bot.log yet — is the container running? ($0 up)"; exit 1; }
    tail -n 200 "$BOTLOG"
    ;;
  *)
    echo "RoseCrypto Account Manager"
    echo ""
    echo "Accounts:"
    echo "  $0 add <username> <password>  - Add an account"
    echo "  $0 list                       - List all accounts"
    echo "  $0 run                        - Run the bot locally (outside docker)"
    echo ""
    echo "Docker:"
    echo "  $0 up                         - Build (if needed) + start container"
    echo "  $0 down                       - Stop container"
    echo "  $0 restart                    - Restart container"
    echo "  $0 rebuild                    - Force rebuild + recreate container"
    echo "  $0 status                     - Container status"
    echo ""
    echo "Logs:"
    echo "  $0 logs                       - Live docker log (entrypoint + bot, Ctrl-C to stop tail)"
    echo "  $0 log                        - Live bot.log tail (per-round detail)"
    echo "  $0 logf                       - Last 200 lines of bot.log"
    ;;
esac
