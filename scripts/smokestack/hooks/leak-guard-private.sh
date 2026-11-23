#!/usr/bin/env bash
# Tier 2 of the re-leak guard: the private patterns from the user-level pattern file, and the
# warnings for staged lines that match them. Sourced by leak-guard.sh beside it, in that shell, so
# it reads the guard's $added, pick and decoded_dir_of and sets local_hits and pattern_args.
# smokestack owns this file and delivers it beside leak-guard.sh with `bun run shared-core:write`;
# change it in smokestack. Like that file it must run under bash 3.2.
# shellcheck shell=bash

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
# Configured: a pattern file was named or seeded. Neither (a scaffolded project) only warns, tier 1.
configured=0
[ -n "$patterns_file" ] && configured=1
patterns_file="${patterns_file:-$HOME/.config/leak-guard/patterns}"
[ -e "$patterns_file" ] && configured=1
self_name="$(git rev-parse --show-toplevel)" || exit 1; self_name="${self_name##*/}"
# A public site may advertise sibling products whose names are private everywhere else, and the
# self-name rule cannot express that. The tracked scripts/smokestack/leak-guard-publishes lists the
# names this repository is cleared to publish, one per line. It is read from the INDEX, so what
# governs a commit is what that commit's reviewer sees, not an unstaged local edit. A pattern is
# cleared only when it matches a listed name in full (-x), so one concatenated entry cannot clear
# two patterns. It clears tier 2 only; secret formats and home paths are never exempt, and each use
# is announced.
publishes="$(
	{ git show :scripts/smokestack/leak-guard-publishes 2>/dev/null || true; } |
		tr -d '\r' | grep -vE '^[[:space:]]*(#|$)' || true
)"
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
	# Each way the tier turns off ends here. tier2_off returns when the commit may go on without it
	# (a scaffolded project, or LEAK_GUARD_ALLOW_NO_PRIVATE=1), and then no pattern work runs at all:
	# it used to fall through to the greps below with no pattern, which bash 3.2 (macOS) stops on as
	# an unbound array under set -u (leak-guard-bash-3-2-empty-pattern-array, starsync CI).
	if [ "$grep_status" -gt 1 ]; then
		tier2_off 'local pattern file could not be read'
	elif [ -z "$active" ]; then
		# A file with no active line is a tier that is off, as surely as a missing file, and it used to
		# skip the private tier without a word. Patterns this repository's own name or its publishes
		# list clear are another matter: those are legitimate, and only announced below.
		tier2_off 'local pattern file holds no pattern'
	else
		# The filter runs in this shell, on a here-string, and keeps each pattern as a grep -e argument,
		# so no failed printf or subshell can drop one; only a match (status 0) clears a pattern. One
		# grep of all settles the usual case, none cleared (exit 1); any other answer walks them one at
		# a time.
		read_patterns="$active" active='' pattern_args=() cleared=0
		while IFS= read -r pattern; do
			if [ -n "$pattern" ]; then active="$active$pattern"$'\n' && pattern_args+=(-e "$pattern"); fi
		done <<<"$read_patterns"
		# nonempty: read_patterns holds at least one active line here, so pattern_args has its -e pair.
		grep -qEi "${pattern_args[@]}" <<<"$self_name" 2>/dev/null || cleared=$?
		# nonempty: the same pattern_args as the line above.
		if [ "$cleared" = 1 ] && [ -n "$publishes" ]; then cleared=0; grep -qxEi "${pattern_args[@]}" <<<"$publishes" 2>/dev/null || cleared=$?; fi
		[ "$cleared" = 1 ] || { active='' pattern_args=(); while IFS= read -r pattern; do
			[ -z "$pattern" ] && continue
			cleared=0; grep -qEi -e "$pattern" <<<"$self_name" 2>/dev/null || cleared=$?
			[ "$cleared" = 0 ] && continue
			cleared=0; [ -n "$publishes" ] && grep -qxEi -e "$pattern" <<<"$publishes" 2>/dev/null || cleared=$?
			[ "$cleared" = 0 ] && echo "leak-guard: a private pattern is cleared for this repo by its leak-guard-publishes" >&2 && continue
			active="$active$pattern"$'\n' && pattern_args+=(-e "$pattern")
		done <<<"$read_patterns"; }
		[ -n "$active" ] || echo "leak-guard: every private pattern is cleared for this repository (its own name or its leak-guard-publishes)" >&2
		if [ -n "$active" ]; then
			# grep exits 1 for no match and 2 when it cannot use a pattern; a pattern it cannot compile
			# is kept above so that it stops the commit here, rather than the private tier going
			# silently off. The staged text without its diff markers, the text private_lines numbers
			# too, so a line-anchored pattern selects the same lines in both passes (Roger #63408).
			# Done in this shell: a + after each newline goes, then the newline put in front to find
			# the first one.
			nl=$'\n'
			# shellcheck disable=SC2154 # added is set by leak-guard.sh before it sources this file
			added_text="$nl$added" && added_text="${added_text//"$nl+"/$nl}" && added_text="${added_text#"$nl"}"
			grep_status=0
			# nonempty: active is non-empty here, and each of its lines added its -e pair alongside.
			local_hits="$(grep -nEi "${pattern_args[@]}" <<<"$added_text")" || grep_status=$?
			if [ "$grep_status" -gt 1 ]; then
				# shellcheck disable=SC2034 # local_hits is read by leak-guard.sh after this file returns
				local_hits=''
				tier2_off 'a private pattern is not a valid expression, so none could be applied'
			fi
		fi
	fi
fi

# "<section>\t<new-file line>\t<text>" for each added line of a patch. A section is one file's diff,
# counted from 1 at each `diff --git`, whose header runs to the first `@@` as hunks() reads it; a
# decoded diff, headers already gone, is all section 0. Removed lines and "\ No newline" markers are
# not in the new file, so they move no line number, and context lines do.
numbered_additions() {
	awk '/^diff --git /{ s++; h=1; next } h && !/^@@/ { next } /^@@ /{ h=0; split($3, n, ","); line = substr(n[1], 2) + 0; next } /^\+/{ printf "%d\t%d\t%s\n", s, line, substr($0, 2); line++; next } /^ /{ line++ }' || exit 1
}

# "<section> <line>" for each row whose text matches a private pattern, once however many patterns
# it matches. The text column alone is matched, so a number never is. Each step is its own: in one
# pipeline a failure before grep left grep no input, and pipefail reported grep's 1, read as no match.
private_hits() {
	local rows="$1" text matched row wanted=' ' index=0 status=0 tab=$'\t' rest
	[ -n "$rows" ] || return 0
	text="$(cut -f3- <<<"$rows")" || exit 1
	# nonempty: private_hits runs only from warn_private, which runs only when local_hits matched.
	matched="$(grep -nEi "${pattern_args[@]}" <<<"$text" 2>/dev/null)" || status=$?
	[ "$status" -le 1 ] || { echo "x leak-guard: a private pattern could not be applied, so the staged content was not checked." >&2; exit 1; }
	[ -n "$matched" ] || return 0
	while IFS= read -r row; do wanted="$wanted${row%%:*} "; done <<<"$matched"
	while IFS= read -r row; do
		index=$((index + 1))
		case "$wanted" in *" $index "*) rest="${row#*"$tab"}" && printf '%s %s\n' "${row%%"$tab"*}" "${rest%%"$tab"*}" || exit 1 ;; esac
	done <<<"$rows"
}

# One warning per matching line, with its file (control characters shown as ?) and new-file line,
# then the count. Never the pattern or the matched text. The fixed prefix is what a replay counts.
# The lines come from the staged patch tier 1 reads, so a rename or type change is judged by what
# it changed (Morticia M-1, L-1), and the match and its line come from one text (Roger #63408).
# git lists the patch's files in the same order with --name-status -z: each record is one section,
# a type change (T) two (its deletion, then its addition), and a rename or copy carries two names,
# warned by the new one. Names stay NUL-delimited, so a name holding a newline is still one file.
# A pipeline, not < <(…): under pipefail a failed listing, or an exit inside the loop, fails the
# group. The guard calls this on the right of &&, where errexit is off, so every step checks its
# own status, and a section or warning count that disagrees with what was matched refuses.
warn_private() {
	local rows hits sections
	# shellcheck disable=SC2154 # patch is set by leak-guard.sh before it sources this file
	rows="$(printf '%s\n' "$patch" | numbered_additions)" || exit 1
	hits="$(private_hits "$rows")" || exit 1
	sections="$(printf '%s\n' "$patch" | awk '/^diff --git /{ s++ } END { print s + 0 }')" || exit 1
	# shellcheck disable=SC2154 # scanned is set by leak-guard.sh, nonempty: it starts as (.)
	git diff --cached --name-status -z -- "${scanned[@]}" | {
		local status name first last section=0 dir own safe numbers sec line total=0 expected=0 hit
		while IFS= read -r hit; do [ -n "$hit" ] && expected=$((expected + 1)); done <<<"$local_hits"
		while IFS= read -r -d '' status; do
			case "$status" in
			R* | C*) { IFS= read -r -d '' name && IFS= read -r -d '' name; } || exit 1 ;;
			*) IFS= read -r -d '' name || exit 1 ;;
			esac
			first=$((section + 1)) section=$((section + 1)) numbers='' dir='' own="$hits"
			[ "$status" = T ] && section=$((section + 1))
			last=$section
			# A decoded UTF-16 file adds no line to the patch; its own decoded diff, all section 0, is read.
			[ -n "${decoded:-}" ] && dir="$(decoded_dir_of "$name")"
			if [ -n "$dir" ]; then
				own="$(numbered_additions <"$dir/u0")" || exit 1
				own="$(private_hits "$own")" || exit 1
				first=0 last=0
			fi
			while read -r sec line; do
				[ -n "$sec" ] && [ "$sec" -ge "$first" ] && [ "$sec" -le "$last" ] && numbers="$numbers $line"
			done <<<"$own"
			[ -n "$numbers" ] || continue
			safe="$(printf '%s' "$name" | LC_ALL=C tr '\000-\037\177' '?')" || exit 1
			for line in $numbers; do
				printf 'leak-guard warning: %s:%s: internal reference: make it generic, or confirm the use is appropriate\n' "$safe" "$line" >&2 || exit 1
				total=$((total + 1))
			done
		done
		printf 'leak-guard warning: %d internal reference(s)\n' "$total" >&2 || exit 1
		[ "$section" = "$sections" ] || { echo "x leak-guard: git listed $section staged file(s) but the patch holds $sections, so warnings could not be placed." >&2; exit 1; }
		[ "$total" = "$expected" ] || { echo "x leak-guard: $expected private match(es) but $total warning(s), so a match was not placed at its line." >&2; exit 1; }
	} || exit 1
}
