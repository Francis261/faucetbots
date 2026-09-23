#!/bin/bash
# OnlyFaucet Account Manager

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT="node $SCRIPT_DIR/bot.mjs"

case "$1" in
  add)
    if [ -z "$2" ]; then
      echo "Usage: $0 add <email>"
      exit 1
    fi
    $BOT add "$2"
    ;;
  list)
    $BOT list
    ;;
  run)
    $BOT
    ;;
  *)
    echo "OnlyFaucet Account Manager"
    echo "Usage:"
    echo "  $0 add <email>    - Add a FaucetPay email"
    echo "  $0 list           - List all accounts"
    echo "  $0 run            - Run the bot"
    ;;
esac
