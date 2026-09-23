#!/bin/bash
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ACCOUNTS="$BASE_DIR/shared/accounts.mjs"

show_menu() {
  clear
  echo "╔══════════════════════════════════════════╗"
  echo "║        CRYPTO FAUCET BOT MANAGER        ║"
  echo "╚══════════════════════════════════════════╝"
  echo ""
  echo "  BOT STATUS"
  echo "  ────────────────────────────────────────"

  # Check claimfreecoins
  CFC_PID=$(ps -eo pid,args | awk '/node claimfreecoins_bot/ && !/awk/ {print $1}' | head -1)
  if [ -n "$CFC_PID" ]; then
    echo "  [1] ClaimFreeCoins   ● running (PID: $CFC_PID)"
  else
    echo "  [1] ClaimFreeCoins   ○ stopped"
  fi

  # Check freelitecoin
  FL_PID=$(ps -eo pid,args | awk '/node freelitecoin_bot/ && !/awk/ {print $1}' | head -1)
  if [ -n "$FL_PID" ]; then
    echo "  [2] FreeLitecoin     ● running (PID: $FL_PID)"
  else
    echo "  [2] FreeLitecoin     ○ stopped"
  fi

  # Check 1xfaucet
  XF_PID=$(ps -eo pid,args | awk '/node bot\\.mjs.*1xfaucet/ && !/awk/ {print $1}' | head -1)
  if [ -n "$XF_PID" ]; then
    echo "  [3] 1XFaucet         ● running (PID: $XF_PID)"
  else
    echo "  [3] 1XFaucet         ○ stopped"
  fi

  echo ""
  echo "  ACTIONS"
  echo "  ────────────────────────────────────────"
  echo "  [3]  Start a bot"
  echo "  [4]  Stop a bot"
  echo "  [5]  Restart a bot"
  echo ""
  echo "  ACCOUNTS"
  echo "  ────────────────────────────────────────"
  echo "  [6]  List all accounts"
  echo "  [7]  Add account"
  echo "  [8]  Remove account"
  echo "  [9]  Enable account"
  echo "  [10] Account stats"
  echo "  [11] Reset all accounts"
  echo ""
  echo "  LOGS"
  echo "  ────────────────────────────────────────"
  echo "  [12] View ClaimFreeCoins log"
  echo "  [13] View FreeLitecoin log"
  echo "  [14] View 1XFaucet log"
  echo ""
  echo "  [0]  Exit"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

pick_bot() {
  echo ""
  echo "  Select bot:"
  echo "    1) ClaimFreeCoins"
  echo "    2) FreeLitecoin"
  echo "    3) 1XFaucet"
  echo -n "  > "
  read choice
  case $choice in
    1) echo "claimfreecoins"; return 0 ;;
    2) echo "freelitecoin"; return 0 ;;
    3) echo "1xfaucet"; return 0 ;;
    *) echo ""; return 1 ;;
  esac
}

do_start() {
  bot=$(pick_bot)
  [ -z "$bot" ] && return
  "$BASE_DIR/$bot/manage.sh" start
  sleep 2
}

do_stop() {
  bot=$(pick_bot)
  [ -z "$bot" ] && return
  "$BASE_DIR/$bot/manage.sh" stop
  sleep 1
}

do_restart() {
  bot=$(pick_bot)
  [ -z "$bot" ] && return
  "$BASE_DIR/$bot/manage.sh" restart
  sleep 2
}

do_log() {
  bot=$(pick_bot)
  [ -z "$bot" ] && return
  echo ""
  echo "  Last 30 lines of $bot log:"
  echo "  ────────────────────────────────────────"
  "$BASE_DIR/$bot/manage.sh" log 30
  echo ""
  echo -n "  Press Enter to continue..."
  read
}

do_add_account() {
  echo ""
  echo -n "  Enter email: "
  read email
  [ -z "$email" ] && return
  echo -n "  Enter faucet URL (or press Enter for default): "
  read url
  if [ -z "$url" ]; then
    node "$ACCOUNTS" add "$email"
  else
    node "$ACCOUNTS" add "$email" "$url"
  fi
  sleep 1
}

do_remove_account() {
  echo ""
  node "$ACCOUNTS" list
  echo ""
  echo -n "  Enter email to remove: "
  read email
  [ -z "$email" ] && return
  node "$ACCOUNTS" remove "$email"
  sleep 1
}

do_enable_account() {
  echo ""
  node "$ACCOUNTS" list
  echo ""
  echo -n "  Enter email to enable: "
  read email
  [ -z "$email" ] && return
  node "$ACCOUNTS" enable "$email"
  sleep 1
}

while true; do
  show_menu
  echo -n "  Select option: "
  read opt
  case $opt in
    1) show_menu; echo "  ClaimFreeCoins log:"; "$BASE_DIR/claimfreecoins/manage.sh" log 15; echo -n "  Press Enter..."; read ;;
    2) show_menu; echo "  FreeLitecoin log:"; "$BASE_DIR/freelitecoin/manage.sh" log 15; echo -n "  Press Enter..."; read ;;
    3) do_start ;;
    4) do_stop ;;
    5) do_restart ;;
    6) node "$ACCOUNTS" list; echo -n "  Press Enter..."; read ;;
    7) do_add_account ;;
    8) do_remove_account ;;
    9) do_enable_account ;;
    10) node "$ACCOUNTS" stats; echo -n "  Press Enter..."; read ;;
    11)
      echo ""
      echo -n "  Reset ALL accounts to active? (y/N): "
      read confirm
      if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
        node "$ACCOUNTS" reset
        echo "  Done."
      fi
      sleep 1
      ;;
    12) bot="claimfreecoins"; do_log ;;
    13) bot="freelitecoin"; do_log ;;
    14) bot="1xfaucet"; do_log ;;
    0|q|Q) echo "  Bye!"; exit 0 ;;
    *) echo "  Invalid option"; sleep 1 ;;
  esac
done
