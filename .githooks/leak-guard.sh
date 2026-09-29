#!/usr/bin/env bash
# Re-leak guard for the public repository (two tiers).
#
# Tier 1 (tracked, below): generic high-signal secret formats and
# home-directory path shapes. Nothing machine- or fleet-specific.
# Tier 2 (untracked): private literals loaded from LEAK_GUARD_PATTERNS, else
# the Windows user-level value of the same name, else
# $HOME/.config/leak-guard/patterns (extended regexes, one per line; blank
# lines and # comments ignored). Seeded by .githooks/leak-guard-setup.sh
# (runs via the `prepare` script). A configured file that is missing or
# unreadable stops the commit unless LEAK_GUARD_ALLOW_NO_PRIVATE=1 is set
# for it; with nothing configured the guard warns and runs tier 1 only.
#
# Scans staged ADDITIONS only. A confirmed false positive is the user's call.
#
# Keep this file byte-identical between the aidd, spernakit, and starsync
# repos, and in sync with scripts/check-leak-guard.sh.
set -euo pipefail

added="$(git diff --cached --unified=0 --no-color -- . ':(exclude).githooks/leak-guard.sh' | grep -E '^\+' | grep -vE '^\+\+\+' || true)"
[ -z "$added" ] && exit 0

# Tier 1a: secret formats (case-insensitive like the rest of the scan).
secret_pattern='AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|\bsk-[A-Za-z0-9_-]{20,}'

# Tier 1a, PEM: the header is checked separately because it is the one secret format whose
# giveaway string is also a legitimate constant. A config validator compares an incoming key
# against it and documentation shows the shape a key takes, so the header on its own says
# "a key goes here", not "a key is here". Blocking it blocks the template that ships those
# files: `git init && git add -A` stages every one of them as an addition, and a scaffolded
# project could not make its first commit.
#
# The leak is the key material, so that is what has to be present: base64 following the header
# on the same line (a one-line JSON or .env value) or a whole added line of nothing but base64
# (a pasted key body). A placeholder remainder like `\n...` or `',` matches neither. The header
# does not have to belong to this commit; the body is what leaks.
pem_header_pattern='-----BEGIN [A-Z ]*PRIVATE KEY-----'
pem_inline_pattern="${pem_header_pattern}.*[A-Za-z0-9+/]{20,}"
pem_body_pattern='^\+[A-Za-z0-9+/]{20,}={0,2}[[:space:]]*$'

# Tier 1b: home-directory paths. Case-SENSITIVE so lowercase route-style
# paths (/users/:id) don't trip it.
path_pattern='[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+/|/home/[a-z0-9._-]+/'

# -e keeps the leading '-----BEGIN …' of the PEM patterns from being parsed as a grep option.
secret_hits="$(printf '%s\n' "$added" | grep -nEi -e "$secret_pattern" || true)"
path_hits="$(printf '%s\n' "$added" | grep -nE -e "$path_pattern" || true)"

# The PEM walk runs over a diff carrying one line of context rather than over $added, because a key
# body can be added under a header that is already committed. The header is then not an addition at
# all, so a scan of additions alone cannot see the pair, and pasting a body under a placeholder
# header is the likeliest way this leak actually happens. Context lines make the adjacency visible
# while '+' still marks what this commit is adding.
pem_diff="$(git diff --cached --unified=1 --no-color -- . ':(exclude).githooks/leak-guard.sh' | grep -vE '^(\+\+\+|---)' || true)"
# Only header lines and the line after each can decide the rule, so the pair-by-pair walk runs over
# those few rather than over the whole diff.
pem_header_lines="$(printf '%s\n' "$pem_diff" | grep -nEi -e "^[+ ].*${pem_header_pattern}" | cut -d: -f1 || true)"
pem_hits=''
for pem_line_no in $pem_header_lines; do
	pem_pair="$(printf '%s\n' "$pem_diff" | sed -n "${pem_line_no},$((pem_line_no + 1))p")"
	pem_header_line="$(printf '%s\n' "$pem_pair" | sed -n 1p)"
	pem_next_line="$(printf '%s\n' "$pem_pair" | sed -n 2p)"
	# Inline material counts only on an ADDED header. A committed header that already carries key
	# material is not what this commit is leaking, and reporting it would block every later commit
	# to that file with no way to clear it short of the bypass.
	if printf '%s\n' "$pem_header_line" | grep -qEi -e "^\+.*${pem_inline_pattern}" ||
		printf '%s\n' "$pem_next_line" | grep -qE -e "$pem_body_pattern"; then
		pem_hits="$(printf '%s\n%s' "$pem_hits" "$pem_line_no:${pem_header_line#?}")"
	fi
done

# Tier 2: private literals from the user-level pattern file.
#
# The pattern file is per-machine, not per-repo, so it names every private sibling — including
# whichever one is being committed to right now. A repository cannot leak its own identity to
# itself: the name is already its directory, its remote URL, and its package name, and it says it
# constantly in its own prose. Drop the patterns that fire on this repo's own name and keep the
# rest, so a private app still guards its siblings' names while being free to write its own.
# Without this the guard is unusable in a private app, which is why it was confined to the public
# repos before. A pattern that grep cannot compile is kept rather than dropped: fail closed.
#
# The environment wins, so a deliberate LEAK_GUARD_PATTERNS still points the hook anywhere. When it
# is unset, Windows is asked directly: a process launched from a parent that predates the user-level
# variable never inherits it, and on 2026-09-25 that left every agent session committing with tier 2
# off for hours.
patterns_file="${LEAK_GUARD_PATTERNS:-}"
if [ -z "$patterns_file" ] && command -v reg.exe >/dev/null 2>&1; then
	patterns_file="$(MSYS_NO_PATHCONV=1 reg.exe query 'HKCU\Environment' /v LEAK_GUARD_PATTERNS 2>/dev/null |
		tr -d '\r' | sed -nE 's/^[[:space:]]*LEAK_GUARD_PATTERNS[[:space:]]+REG_(EXPAND_)?SZ[[:space:]]+//p' || true)"
fi
# Configured means someone chose a pattern file: named it, or seeded the default. A machine where
# neither happened (a scaffolded project, which carries no seeder) keeps the old tier-1-only warning.
configured=0
[ -n "$patterns_file" ] && configured=1
patterns_file="${patterns_file:-$HOME/.config/leak-guard/patterns}"
[ -e "$patterns_file" ] && configured=1
self_name="$(basename "$(git rev-parse --show-toplevel)")"
# A public site may advertise sibling products whose names are private everywhere else, and the
# self-name rule cannot express that. The tracked .githooks/leak-guard-publishes lists the names
# this repository is cleared to publish, one per line. It is read from the INDEX, so what governs a
# commit is what that commit's reviewer sees, not an unstaged local edit. A pattern is cleared only
# when it matches a listed name in full (-x), so one concatenated entry cannot clear two patterns.
# It clears tier 2 only; secret formats and home paths are never exempt, and each use is announced.
publishes="$(git show :.githooks/leak-guard-publishes 2>/dev/null | tr -d '\r' | grep -vE '^[[:space:]]*(#|$)' || true)"
local_hits=''
# A configured tier the guard cannot read is a guard that is off, and it used to say so in one stderr
# line above 'passed'. A configured file that is missing or unreadable (an account the file's ACL
# leaves out) now stops the commit. Committing without it is the user's call, made per commit.
tier2_off() {
	if [ "$configured" = 0 ]; then
		echo "leak-guard: $1 ($patterns_file); generic checks only" >&2
		return 0
	fi
	if [ "${LEAK_GUARD_ALLOW_NO_PRIVATE:-}" = 1 ]; then
		echo "leak-guard: $1 ($patterns_file); LEAK_GUARD_ALLOW_NO_PRIVATE=1, generic checks only" >&2
		return 0
	fi
	echo "x leak-guard: $1 ($patterns_file), so the private tier cannot run." >&2
	echo "  Point LEAK_GUARD_PATTERNS at a pattern file this account can read. Committing without" >&2
	echo "  it is the user's call, made for that commit with LEAK_GUARD_ALLOW_NO_PRIVATE=1." >&2
	exit 1
}
if [ ! -f "$patterns_file" ]; then
	tier2_off 'no local pattern file'
elif [ ! -r "$patterns_file" ]; then
	tier2_off 'local pattern file is not readable'
else
	# grep exits 1 when every line is a comment and 2 when it cannot read the file. Only the second is
	# a failure, and it is checked here because -r above is not reliable against Windows ACLs.
	grep_status=0
	active="$(grep -vE '^[[:space:]]*(#|$)' "$patterns_file")" || grep_status=$?
	[ "$grep_status" -gt 1 ] && tier2_off 'local pattern file could not be read'
	active="$(printf '%s\n' "$active" | while IFS= read -r pattern; do
		[ -z "$pattern" ] && continue
		printf '%s\n' "$self_name" | grep -qEi -e "$pattern" 2>/dev/null && continue
		if [ -n "$publishes" ] && printf '%s\n' "$publishes" | grep -qxEi -e "$pattern" 2>/dev/null; then
			echo "leak-guard: a private pattern is cleared for this repo by .githooks/leak-guard-publishes" >&2
			continue
		fi
		printf '%s\n' "$pattern"
	done)"
	if [ -n "$active" ]; then
		local_hits="$(printf '%s\n' "$added" | grep -nEi -f <(printf '%s\n' "$active") || true)"
	fi
fi

hits="$(printf '%s\n%s\n%s\n%s\n' "$secret_hits" "$pem_hits" "$path_hits" "$local_hits" | sed '/^$/d')"
if [ -n "$hits" ]; then
	echo "" >&2
	echo "x re-leak guard: staged changes contain forbidden private/secret patterns:" >&2
	printf '%s\n' "$hits" | head -20 >&2
	echo "" >&2
	echo "  Scrub these before committing. A confirmed false positive is the user's" >&2
	echo "  call to make, not a reason to skip the hook." >&2
	exit 1
fi
exit 0
