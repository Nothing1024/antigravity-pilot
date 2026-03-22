#!/bin/bash
# language_server_macos_arm 资源监控与调控脚本
# Usage: ./scripts/ls-monitor.sh [monitor|status|throttle|kill]

set -euo pipefail

LS_NAME="language_server_macos_arm"

color_red='\033[0;31m'
color_green='\033[0;32m'
color_yellow='\033[1;33m'
color_blue='\033[0;34m'
color_cyan='\033[0;36m'
color_reset='\033[0m'

# ── Status ────────────────────────────────────────────────────────
status() {
  echo -e "${color_cyan}═══════════════════════════════════════════════════════════════${color_reset}"
  echo -e "${color_cyan}    language_server_macos_arm 资源状态${color_reset}"
  echo -e "${color_cyan}═══════════════════════════════════════════════════════════════${color_reset}"
  echo ""

  local total_cpu=0
  local total_mem=0
  local count=0

  while IFS= read -r line; do
    pid=$(echo "$line" | awk '{print $2}')
    cpu=$(echo "$line" | awk '{print $3}')
    mem_pct=$(echo "$line" | awk '{print $4}')
    rss=$(echo "$line" | awk '{print $6}')
    time=$(echo "$line" | awk '{print $10}')
    workspace=$(echo "$line" | grep -o -- '--workspace_id [^ ]*' | sed 's/--workspace_id //' | sed 's/file_Users_nothing_/~\//')

    rss_mb=$(echo "scale=1; $rss / 1024" | bc)
    total_cpu=$(echo "$total_cpu + $cpu" | bc)
    total_mem=$(echo "$total_mem + $rss" | bc)
    count=$((count + 1))

    # Color code CPU
    if (( $(echo "$cpu > 50" | bc -l) )); then
      cpu_color=$color_red
    elif (( $(echo "$cpu > 10" | bc -l) )); then
      cpu_color=$color_yellow
    else
      cpu_color=$color_green
    fi

    # Color code memory
    if (( $(echo "$rss > 800000" | bc -l) )); then
      mem_color=$color_red
    elif (( $(echo "$rss > 500000" | bc -l) )); then
      mem_color=$color_yellow
    else
      mem_color=$color_green
    fi

    echo -e "  PID: ${color_blue}${pid}${color_reset}"
    echo -e "    CPU:       ${cpu_color}${cpu}%${color_reset}"
    echo -e "    Memory:    ${mem_color}${rss_mb} MB${color_reset} (${mem_pct}%)"
    echo -e "    Runtime:   ${time}"
    echo -e "    Workspace: ${workspace}"

    # Thread count
    thread_count=$(ps -M "$pid" 2>/dev/null | wc -l | tr -d ' ')
    echo -e "    Threads:   ${thread_count}"

    # TCP connections
    tcp_count=$(lsof -p "$pid" 2>/dev/null | grep -c "TCP" || true)
    echo -e "    TCP Conns:  ${tcp_count}"

    # Open files
    fd_count=$(lsof -p "$pid" 2>/dev/null | wc -l | tr -d ' ')
    echo -e "    Open FDs:  ${fd_count}"
    echo ""
  done < <(ps aux | grep "$LS_NAME" | grep -v grep | grep -v "ls-monitor")

  total_mem_mb=$(echo "scale=1; $total_mem / 1024" | bc)
  echo -e "${color_cyan}───────────────────────────────────────────────────────────────${color_reset}"
  echo -e "  Total instances: ${color_blue}${count}${color_reset}"
  echo -e "  Total CPU:       ${color_yellow}${total_cpu}%${color_reset}"
  echo -e "  Total Memory:    ${color_yellow}${total_mem_mb} MB${color_reset}"
  echo -e "${color_cyan}═══════════════════════════════════════════════════════════════${color_reset}"
}

# ── Monitor (live) ────────────────────────────────────────────────
monitor() {
  echo -e "${color_cyan}Live monitoring (Ctrl+C to exit, refreshing every 3s)...${color_reset}"
  while true; do
    clear
    status
    echo ""
    echo -e "${color_blue}[$(date '+%H:%M:%S')] Press Ctrl+C to stop ${color_reset}"
    sleep 3
  done
}

# ── Throttle (via cpulimit) ───────────────────────────────────────
throttle() {
  local limit=${1:-50}
  echo -e "${color_yellow}Throttling all language_server instances to ${limit}% CPU...${color_reset}"

  if ! command -v cpulimit &>/dev/null; then
    echo -e "${color_red}cpulimit not installed. Install with: brew install cpulimit${color_reset}"
    exit 1
  fi

  while IFS= read -r pid; do
    workspace=$(ps aux | grep "^.*${pid}.*--workspace_id" | grep -o -- '--workspace_id [^ ]*' | sed 's/--workspace_id //' | sed 's/file_Users_nothing_/~\//')
    echo -e "  Limiting PID ${color_blue}${pid}${color_reset} (${workspace}) to ${limit}%"
    cpulimit -p "$pid" -l "$limit" -b 2>/dev/null || echo "    (already limited or process gone)"
  done < <(pgrep -f "$LS_NAME")

  echo -e "${color_green}Done. Use 'pkill cpulimit' to remove all limits.${color_reset}"
}

# ── Kill specific workspace LS ────────────────────────────────────
kill_workspace() {
  local target=${1:-}
  if [ -z "$target" ]; then
    echo "Available workspaces:"
    ps aux | grep "$LS_NAME" | grep -v grep | grep -o -- '--workspace_id [^ ]*' | sed 's/--workspace_id //' | nl
    echo ""
    echo "Usage: $0 kill <workspace_id_substring>"
    return
  fi

  local pids
  pids=$(ps aux | grep "$LS_NAME" | grep -v grep | grep "$target" | awk '{print $2}')

  if [ -z "$pids" ]; then
    echo -e "${color_red}No language_server found for workspace: ${target}${color_reset}"
    return
  fi

  for pid in $pids; do
    workspace=$(ps aux | grep "^.*${pid}.*--workspace_id" | grep -o -- '--workspace_id [^ ]*' | sed 's/--workspace_id //' | sed 's/file_Users_nothing_/~\//')
    echo -e "${color_yellow}Killing PID ${pid} (${workspace})${color_reset}"
    kill "$pid"
  done
  echo -e "${color_green}Done. The language server will restart when you interact with the window.${color_reset}"
}

# ── Renice (lower priority) ──────────────────────────────────────
renice_ls() {
  local priority=${1:-10}
  echo -e "${color_yellow}Setting all language_server instances to nice priority ${priority}...${color_reset}"

  while IFS= read -r pid; do
    workspace=$(ps aux | grep "^.*${pid}.*--workspace_id" | grep -o -- '--workspace_id [^ ]*' | sed 's/--workspace_id //' | sed 's/file_Users_nothing_/~\//')
    echo -e "  Renicing PID ${color_blue}${pid}${color_reset} (${workspace})"
    renice "$priority" -p "$pid" 2>/dev/null || echo "    (need sudo: sudo renice $priority -p $pid)"
  done < <(pgrep -f "$LS_NAME")
}

# ── Main ──────────────────────────────────────────────────────────
case "${1:-status}" in
  status)
    status
    ;;
  monitor)
    monitor
    ;;
  throttle)
    throttle "${2:-50}"
    ;;
  kill)
    kill_workspace "${2:-}"
    ;;
  renice)
    renice_ls "${2:-10}"
    ;;
  *)
    echo "Usage: $0 {status|monitor|throttle [cpu%]|kill [workspace]|renice [priority]}"
    echo ""
    echo "Commands:"
    echo "  status          Show current resource usage"
    echo "  monitor         Live monitoring (refresh every 3s)"
    echo "  throttle [N]    Limit CPU to N% per instance (requires cpulimit)"
    echo "  kill [ws]       Kill LS for a specific workspace"
    echo "  renice [N]      Lower scheduling priority (default: 10)"
    ;;
esac
