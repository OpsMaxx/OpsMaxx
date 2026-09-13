#!/bin/sh
# Advisory only: never blocks, never prompts, never fails a tool call.
#
# The observed failure is reaching for a raw `ssh you@host` when the same work
# through this bridge would be scoped, approved and audited -- and would not need
# the hostname the agent had to guess at.
#
# This runs before EVERY Bash call, so it has to be nearly free. Hence sh and
# grep rather than jq or node: a process spawn per tool use is a tax paid
# forever, and the matching here does not need to be exact. It is a nudge. A
# false positive costs one line of context; a miss costs nothing.
#
# The emitted JSON is a constant, so no shell value is ever interpolated into it
# and there is nothing to escape.

if grep -qE '"command"[[:space:]]*:[[:space:]]*"(sudo +)?(ssh|scp|sftp)[[:space:]]' 2>/dev/null; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "This looks like a direct ssh/scp/sftp call. If the target is a server configured in OpsMaxx, prefer the MCP tools: list_servers to get its friendly name, then execute_command, read_file, list_files or get_server_metrics. They are scoped per capability, approved in the app and audited, and they do not need a hostname or a key. If the host is not in OpsMaxx, carry on -- this is advice, not a refusal."
  }
}
JSON
fi

exit 0
