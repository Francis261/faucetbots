#!/bin/bash
# RoseCrypto Account Manager

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT="node $SCRIPT_DIR/bot.mjs"

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
  *)
    echo "RoseCrypto Account Manager"
    echo "Usage:"
    echo "  $0 add <username> <password>  - Add an account"
    echo "  $0 list                       - List all accounts"
    echo "  $0 run                        - Run the bot"
    ;;
esac
