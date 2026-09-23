#!/bin/bash
BOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_NAME="claimfreecoins"
BOT_FILE="claimfreecoins_bot.mjs"
LOG_FILE="claimfreecoins_bot.log"
PID_CMD="ps -eo pid,args | awk '/node $BOT_FILE/ && !/awk/ {print \$1}'"

case "$1" in
  start)
    if eval "$PID_CMD" | grep -q .; then
      echo "[$BOT_NAME] already running (PID: $(eval $PID_CMD))"
      exit 1
    fi
    rm -f "$BOT_DIR/$LOG_FILE"
    cd "$BOT_DIR" && setsid nohup node "$BOT_FILE" </dev/null >"$LOG_FILE" 2>&1 &
    disown
    sleep 1
    PID=$(eval "$PID_CMD")
    echo "[$BOT_NAME] started (PID: $PID)"
    ;;
  stop)
    PID=$(eval "$PID_CMD")
    if [ -z "$PID" ]; then
      echo "[$BOT_NAME] not running"
      exit 1
    fi
    eval "$PID_CMD" | while read pid; do kill "$pid" 2>/dev/null; done
    echo "[$BOT_NAME] stopped"
    ;;
  restart)
    $0 stop
    sleep 1
    $0 start
    ;;
  status)
    PID=$(eval "$PID_CMD")
    if [ -z "$PID" ]; then
      echo "[$BOT_NAME] not running"
    else
      echo "[$BOT_NAME] running (PID: $PID)"
    fi
    ;;
  log|logs)
    if [ -f "$BOT_DIR/$LOG_FILE" ]; then
      tail -${2:-30} "$BOT_DIR/$LOG_FILE"
    else
      echo "[$BOT_NAME] no log file found"
    fi
    ;;
  logf|logfollow|follow)
    tail -f "$BOT_DIR/$LOG_FILE"
    ;;
  accounts)
    node "$BOT_DIR/../shared/accounts.mjs" ${@:2}
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|log [lines]|logf|accounts [cmd]}"
    echo ""
    echo "Commands:"
    echo "  start       Start the bot"
    echo "  stop        Stop the bot"
    echo "  restart     Restart the bot"
    echo "  status      Check if bot is running"
    echo "  log [N]     Show last N lines of log (default: 30)"
    echo "  logf        Follow/tail the log"
    echo "  accounts    Manage accounts (list, add, remove, etc.)"
    ;;
esac
