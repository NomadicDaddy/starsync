# shellcheck shell=bash disable=SC2034 # the variables set here are read by the sourcing script
# Setup for the leak-guard self-test, sourced (never run) before any case.
#
# check-leak-guard.sh sources this first, and so does the hook-environment test on its own. That
# test only needs to show that the scratch repositories built here ignore git's hook environment,
# and running every case for that took two minutes a run. So everything a case relies on lives here:
# git's local environment cleared, the scratch folder and its cleanup, the failure count, the
# fixtures, the synthetic pattern files, both scratch repositories, run_guard, and lane_begin, which
# gives each lane of cases its own copy of the scratch.
#
# It runs in the sourcing shell. The EXIT trap below is that shell's trap, and the sourcing script's
# `set -euo pipefail` applies here too, which is what a case needs. The paths come from
# BASH_SOURCE, not $0, because $0 is whichever script sourced this.
#
# smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
# smokestack; every repository that takes it holds a byte-identical copy.

# This file's own directory, where check-leak-guard-cases.sh sits beside it.
self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The repository is the parent of the nearest scripts directory above this file, at any depth.
scripts_dir="$self_dir"
while [ "$(basename "$scripts_dir")" != scripts ]; do
	if [ "$(dirname "$scripts_dir")" = "$scripts_dir" ]; then
		echo "check-leak-guard: no scripts directory above ${BASH_SOURCE[0]}" >&2
		exit 2
	fi
	scripts_dir="$(dirname "$scripts_dir")"
done
repo_root="$(dirname "$scripts_dir")"
# The guard under test: in scripts/smokestack/hooks where a repository takes it, and in .githooks in
# smokestack itself, which runs its own hooks from there.
hook="$scripts_dir/smokestack/hooks/leak-guard.sh"
[ -f "$hook" ] || hook="$repo_root/.githooks/leak-guard.sh"
# Where the scratch repositories hold it, as a repository that takes it does.
guard=scripts/smokestack/hooks/leak-guard.sh

# A command that fails outside a check ends the self-test under `set -e` with no FAIL line and no
# summary: full gates saw it exit 1 with nothing to say why (Morticia I-4). So the ERR trap records
# where the last command in the main shell failed, and when the run ends non-zero without having
# printed its own summary, the EXIT trap names that place on both streams and keeps the status.
# Only the file and line are printed, never the command: its text can hold fixture pieces. A lane
# (lane_begin, below) is a subshell running its own cases, so "the main shell" is the lane's own
# level there: lane_depth.
set -E
self_test_failed_at=''
self_test_reported=''
lane_depth=0 lane_pids='' lanes=''
# The file name alone, cut at either separator: a full path can hold the user's home directory.
trap '[ "$BASH_SUBSHELL" -ne "$lane_depth" ] || self_test_failed_at="${BASH_SOURCE[0]##*[/\\]}:$LINENO"' ERR
self_test_exit() {
	local status=$?
	if [ "$status" -ne 0 ] && [ -z "$self_test_reported" ]; then
		local where="no failing command was recorded"
		[ -z "$self_test_failed_at" ] || where="the last failing command was at $self_test_failed_at"
		echo "check-leak-guard: stopped early with exit $status; $where"
		echo "check-leak-guard: stopped early with exit $status; $where" >&2
	fi
	# A lane still running is stopped with everything it started, and waited for, before its folder
	# goes. Each lane is its own process group (check-leak-guard.sh starts them under set -m), so the
	# group signal reaches a git or guard run in progress too: signalling the lane shell alone left
	# such a child running, and it wrote into the removed scratch afterwards (Roger, Morticia on
	# 02cefb3). Every lane's scratch is inside $lanes, so removing it removes theirs.
	local pid
	for pid in $lane_pids; do kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; done
	# shellcheck disable=SC2086 # one process id per word
	if [ -n "$lane_pids" ]; then wait $lane_pids 2>/dev/null || true; fi
	# set -e holds inside this trap, so a removal that fails would end it before the next one ran:
	# each is tried whatever the last did (Morticia on 02cefb3).
	if [ -n "$lanes" ]; then rm -rf "$lanes" || true; fi
	if [ -n "${tmp:-}" ]; then rm -rf "$tmp" || true; fi
	exit "$status"
}
trap self_test_exit EXIT

# Run from a hook, git's own environment points at the real repository: a pathspec commit hands
# its hooks an absolute GIT_INDEX_FILE. The scratch repositories below must not write into it.
# shellcheck disable=SC2046 # one variable name per word, which unset needs split
unset $(git rev-parse --local-env-vars)

failures=0
# A failure also shows what the guard last said. A message check that fails on another platform
# otherwise says only which message was missing, never which refusal took its place (beazley.org's
# Cloudflare build, case 19, Auden #41218). The fixtures are synthetic, and case 13 proves a refusal
# never repeats what it refused, so this prints no real secret. It is the LAST guard run's output,
# which a check that runs no guard of its own did not produce, so the label says so (Morticia, Roger
# #41267).
fail() {
	echo "check-leak-guard: FAIL - $1" >&2
	if [ -s "$tmp/stderr" ]; then sed 's/^/check-leak-guard:   last guard run said: /' "$tmp/stderr" >&2; fi
	failures=$((failures + 1))
}

# Tier 2 warns instead of refusing (leak-guard-private-tier-warns): true when the last guard run
# warned at $1 (<file>:<new-file line>) and printed no synthetic private name anywhere.
warned_at() {
	grep -qF "leak-guard warning: $1: internal reference: make it generic, or confirm the use is appropriate" "$tmp/stderr" &&
		! grep -qE 'zzz-(synthetic|sibling)-app' "$tmp/stderr"
}
# True when the last guard run gave no tier-2 warning at all.
not_warned() { ! grep -q '^leak-guard warning: .*internal reference: ' "$tmp/stderr"; }
# True when a guard run passed (its exit code is $1) and warned at $2, or passed and warned nowhere.
passed_warning() { [ "$1" = 0 ] && warned_at "$2"; }
passed_quietly() { [ "$1" = 0 ] && not_warned; }

# Fixtures every case file reads, built at runtime so no file here holds what the guard refuses.
aws_key="AKIA$(printf 'A%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16)"
pem_header="-----BEGIN RSA $(printf 'PRIVATE') KEY-----"
b64_run="$(printf 'A%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24)"
bs="$(printf '\134')"
win_path="C:${bs}Users${bs}someone${bs}project"

# Scratch repo names are load-bearing for cases 9 and 10: the guard drops tier-2 patterns that
# match the repository's own directory name, so the two repos differ only in what they are called.
make_repo() {
	mkdir -p "$tmp/$1/$(dirname "$guard")"
	git -C "$tmp/$1" init -q
	# Before the first commit: a core.hooksPath in the global configuration would otherwise run its
	# hooks on every scratch commit (Morticia #40460, the gap Roger found in repose's copy, #40251).
	mkdir -p "$tmp/no-hooks"
	git -C "$tmp/$1" config core.hooksPath "$tmp/no-hooks"
	git -C "$tmp/$1" -c user.email=t@test -c user.name=t commit -q --allow-empty -m init
	cp "$hook" "$tmp/$1/$guard"
	# The guard sources its UTF-16 decoder from its own folder when a binary file is staged, and its
	# private tier (leak-guard-private.sh) on every run.
	cp "$(dirname "$hook")/leak-guard-decode.sh" "$tmp/$1/$(dirname "$guard")/"
	cp "$(dirname "$hook")/leak-guard-private.sh" "$tmp/$1/$(dirname "$guard")/"
}

# A scratch folder, its pattern files and both scratch repositories. Run once here, and once more
# in each lane, so that lanes running at the same time never share a repository or a file. A lane's
# scratch is made inside the folder $1, which the main shell removes after the lane has ended.
make_scratch() {
	if [ -n "${1:-}" ]; then tmp="$(mktemp -d "$1/scratch.XXXXXX")"; else tmp="$(mktemp -d)"; fi
	# The scratch repositories read no global or system git configuration either, so a build
	# machine's settings (rename detection, say) cannot change which step of the guard refuses
	# first. Morticia #41245, after case 19 refused for another reason in beazley.org's Cloudflare
	# build. An empty file, not /dev/null, so it reads the same under every git.
	: >"$tmp/gitconfig-none"
	export GIT_CONFIG_GLOBAL="$tmp/gitconfig-none" GIT_CONFIG_NOSYSTEM=1
	synthetic="$tmp/patterns"
	printf '%s\n' '# synthetic private patterns for the self-test' '' '\bzzz-synthetic-app\b' >"$synthetic"
	printf '%s\n' '\bzzz-synthetic-app\b' '\bzzz-sibling-app\b' >"$tmp/patterns-pair"
	make_repo repo
	make_repo zzz-synthetic-app
	# The repo the next run_guard call runs in. Cases 1-8 use the neutrally named one.
	guard_repo="$tmp/repo"
}
make_scratch

# Starts a lane: called first in a function run in the background, with lane_out set to the lane's
# path under $lanes, to run one case file beside the others. It takes the lane's own scratch and
# failure count, and the lane's EXIT trap cleans only that scratch: the parent's tmp and the other
# lanes are not this lane's to remove or stop.
lane_begin() {
	lane_depth=$BASH_SUBSHELL lane_pids='' lanes='' tmp='' failures=0
	trap self_test_exit EXIT
	# shellcheck disable=SC2154 # set by the lane function that calls this, in check-leak-guard.sh
	make_scratch "${lane_out%/*}"
}

# Waits for lane $1, the first process in lane_pids, prints what it said, and adds its failures. Its
# exit status counts too, even with a count written: the count is written before the lane's EXIT
# trap runs, and a lane that then exits non-zero has not passed (Roger, a0f143e).
lane_collect() {
	local pid="${lane_pids%% *}" status=0
	# The pid leaves lane_pids only once the lane has ended: stopped during this wait, the self-test's
	# EXIT trap must still find the lane to stop it (Morticia on 02cefb3).
	wait "$pid" || status=$?
	lane_pids="${lane_pids#"$pid"}" && lane_pids="${lane_pids# }"
	cat "$lanes/$1.out"
	cat "$lanes/$1.err" >&2
	if [ -f "$lanes/$1.failures" ]; then failures=$((failures + $(cat "$lanes/$1.failures"))); fi
	if [ "$status" -ne 0 ] || [ ! -f "$lanes/$1.failures" ]; then
		echo "check-leak-guard: FAIL - the $1 lane ended with exit $status" >&2
		failures=$((failures + 1))
	fi
}

# Stages $2 as file content and runs the guard with pattern file $1.
# Prints the guard's exit code; guard stderr lands in $tmp/stderr.
run_guard() {
	printf '%s\n' "$2" >"$guard_repo/staged.txt"
	git -C "$guard_repo" add staged.txt
	local code=0
	(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$1" bash "$guard") 2>"$tmp/stderr" || code=$?
	echo "$code"
}
