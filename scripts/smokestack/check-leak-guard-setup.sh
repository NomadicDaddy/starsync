# shellcheck shell=bash disable=SC2034 # the variables set here are read by the sourcing script
# Setup for the leak-guard self-test, sourced (never run) before any case.
#
# check-leak-guard.sh sources this first, and so does the hook-environment test on its own. That
# test only needs to show that the scratch repositories built here ignore git's hook environment,
# and running every case for that took two minutes a run. So everything a case relies on lives here:
# git's local environment cleared, the scratch folder and its cleanup, the failure count, the
# synthetic pattern file, both scratch repositories and run_guard.
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

# Run from a hook, git's own environment points at the real repository: a pathspec commit hands
# its hooks an absolute GIT_INDEX_FILE. The scratch repositories below must not write into it.
# shellcheck disable=SC2046 # one variable name per word, which unset needs split
unset $(git rev-parse --local-env-vars)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failures=0
fail() {
	echo "check-leak-guard: FAIL - $1" >&2
	failures=$((failures + 1))
}

synthetic="$tmp/patterns"
printf '%s\n' '# synthetic private patterns for the self-test' '' '\bzzz-synthetic-app\b' >"$synthetic"

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
	# The guard sources its UTF-16 decoder from its own folder when a binary file is staged.
	cp "$(dirname "$hook")/leak-guard-decode.sh" "$tmp/$1/$(dirname "$guard")/"
}
make_repo repo
make_repo zzz-synthetic-app

# The repo the next run_guard call runs in. Cases 1-8 use the neutrally named one.
guard_repo="$tmp/repo"

# Stages $2 as file content and runs the guard with pattern file $1.
# Prints the guard's exit code; guard stderr lands in $tmp/stderr.
run_guard() {
	printf '%s\n' "$2" >"$guard_repo/staged.txt"
	git -C "$guard_repo" add staged.txt
	local code=0
	(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$1" bash "$guard") 2>"$tmp/stderr" || code=$?
	echo "$code"
}
