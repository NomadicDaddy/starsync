#!/usr/bin/env bash
# Re-leak guard for the public repository (two tiers).
#
# Tier 1 (tracked, below): generic high-signal secret formats and
# home-directory path shapes. Nothing machine- or fleet-specific.
# Tier 2 (untracked): private literals loaded from LEAK_GUARD_PATTERNS, else
# the Windows user-level value of the same name, else
# $HOME/.config/leak-guard/patterns (extended regexes, one per line; blank
# lines and # comments ignored). Seeded by leak-guard-setup.sh beside it
# (runs via the `prepare` script). A configured file that is missing, empty or
# unreadable stops the commit unless LEAK_GUARD_ALLOW_NO_PRIVATE=1 is set
# for it; with nothing configured the guard warns and runs tier 1 only.
#
# Scans staged ADDITIONS only. A confirmed false positive is the user's call.
# Additions to this file itself are excluded, because it has to spell out the patterns it looks
# for; what keeps this one file honest is that every repository's copy is byte-checked against
# its owner. The hooks run this under whichever of /usr/bin/bash and /bin/bash exists, and on
# macOS that is bash 3.2, so nothing here may need a newer bash.
#
# smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
# smokestack; every repository that takes it holds a byte-identical copy. Keep it in step with
# scripts/smokestack/check-leak-guard.sh in a repository that takes it (scripts/check-leak-guard.sh
# here), which tests it.
set -euo pipefail

# grep where exit 1 (nothing selected) is an answer and 2 or more (it could not run) refuses: a
# failed filter used to leave a tier nothing to scan, and pass. In a $(…) the refusal ends only that
# subshell, so each content producer adds `|| exit 1`. picks tests a match the same way; it reads a
# here-string so it runs in this shell, where a refusal cannot be mistaken for "no match".
pick() {
	local status=0
	grep "$@" || status=$?
	[ "$status" -le 1 ] || { echo "x leak-guard: grep failed ($status), so the staged content was not checked." >&2; exit 1; }
}
picks() {
	local status=0
	grep -q "$@" || status=$?
	[ "$status" -le 1 ] || { echo "x leak-guard: grep failed ($status), so the staged content was not checked." >&2; exit 1; }
	[ "$status" = 0 ]
}

# What is scanned: everything staged but this file, whose path git gives (.githooks/ here,
# scripts/smokestack/hooks/ elsewhere). A copy git does not index is in no staged diff.
self_path="$(git ls-files --full-name -- "$0" 2>/dev/null || true)"
self_path="${self_path%%$'\n'*}"
scanned=(.)
[ -n "$self_path" ] && scanned+=(":(exclude)$self_path")

# Tier 1c: key files by name. A binary or encrypted key (DER .key, PKCS#12/#8, PuTTY, a keystore, a
# wrapped PEM) has no header for the content scan. A bare .gpg or .pgp is refused, since nothing in
# it names what it wraps; .asc (mostly signatures) and .der (as often a public certificate) are not.
# A deletion is never refused. There is no exemption list (design review #17104).
key_name_pattern='\.(pem|key|p12|pfx|p8|ppk|jks|keystore)(\.(gpg|asc|pgp|age|enc))?$|\.(gpg|pgp)$'
# Prints each staged file whose last path segment is key-shaped, NUL-terminated; -z keeps a name
# with a newline, quotes or non-ASCII whole, and T counts a symlink that became a file.
key_named_files() {
	local file
	# A pipeline, not < <(…): under pipefail a failed listing fails this function, and its caller.
	git diff --cached --name-only -z --diff-filter=ACMRT -- "${scanned[@]}" | while IFS= read -r -d '' file; do
		if picks -Ei -e "$key_name_pattern" <<<"${file##*/}"; then printf '%s\0' "$file" || exit 1; fi
	done
}
# The loop above cannot tell an index git could not list from an empty one, so ask first: a guard
# that cannot read the staged names has not checked them.
if ! git diff --cached --name-only -z --diff-filter=ACMRT -- "${scanned[@]}" >/dev/null; then
	echo "x leak-guard: git could not list the staged files, so key file names were not checked." >&2
	exit 1
fi
key_hits="$(key_named_files | tr '\0' '\n')" || exit 1

# The staged patch (with $1 lines of context) is read whole and its exit checked, as the listing is
# above: piped into grep, a patch git could not produce left the tiers nothing, and the guard passed.
staged_patch() {
	if ! git diff --cached --unified="$1" --no-color --no-textconv -- "${scanned[@]}"; then
		echo "x leak-guard: git could not produce the staged changes, so their content was not checked." >&2
		exit 1
	fi
}
patch="$(staged_patch 0)" || exit 1
added="$(printf '%s\n' "$patch" | pick -E '^\+' | pick -vE '^\+\+\+')" || exit 1
# A file git calls binary adds no lines here: leak-guard-decode.sh, beside this one, reads it instead.
numstat="$(git diff --cached --numstat -- "${scanned[@]}")" || exit 1
decoded_pem=''
case $'\n'"$numstat" in *$'\n-\t-\t'*)
	decoder="$(dirname "$0")/leak-guard-decode.sh"
	if [ ! -f "$decoder" ]; then
		echo "x leak-guard: binary files are staged and $decoder is missing, so they were not checked." >&2
		exit 1
	fi
	# shellcheck source-path=SCRIPTDIR source=leak-guard-decode.sh
	. "$decoder"
	trap '[ -n "$decoded" ] && rm -rf "$decoded"' EXIT
	decode_staged_binaries
	added="$added$decoded_added"
	;;
esac
[ -z "$added$key_hits" ] && exit 0

# Tier 1a: secret formats (case-insensitive like the rest of the scan).
secret_pattern='AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|\bsk-[A-Za-z0-9_-]{20,}'

# Tier 1a, PEM: the header alone is a legitimate constant (validators compare against it, docs show
# it, and a scaffolded project stages it in its first commit), so it says "a key goes here". The leak
# is the key material: base64 after the header on its line (a one-line JSON or .env value), or a
# whole added line of base64 (a pasted body). A placeholder like `\n...` matches neither. The header
# need not belong to this commit; the body is what leaks.
pem_header_pattern='-----BEGIN [A-Z ]*PRIVATE KEY-----'
pem_inline_pattern="${pem_header_pattern}.*[A-Za-z0-9+/]{20,}"
pem_body_pattern='^\+[A-Za-z0-9+/]{20,}={0,2}[[:space:]]*$'

# Tier 1b: home-directory paths. Case-SENSITIVE so lowercase route-style
# paths (/users/:id) don't trip it.
path_pattern='[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+/|/home/[a-z0-9._-]+/'

# -e keeps the leading '-----BEGIN …' of the PEM patterns from being parsed as a grep option.
secret_hits="$(printf '%s\n' "$added" | pick -nEi -e "$secret_pattern")" || exit 1
path_hits="$(printf '%s\n' "$added" | pick -nE -e "$path_pattern")" || exit 1

# The PEM walk reads a diff with one line of context, not $added: a body pasted under a header that
# is already committed (the likeliest way this leaks) pairs an addition with a context line.
# pem_scan reads such a diff on stdin and prints one line per key. The refusal below names files by
# the same function, so it never names a file that only shows the shape a key takes.
pem_scan() {
	local pem_diff pem_header_lines pem_line_no pem_pair pem_header_line pem_next_line
	pem_diff="$(cat)" || exit 1
	# Only header lines and the line after each can decide the rule, so only those few are walked.
	pem_header_lines="$(printf '%s\n' "$pem_diff" | pick -nEi -e "^[+ ].*${pem_header_pattern}" | cut -d: -f1)" || exit 1
	for pem_line_no in $pem_header_lines; do
		pem_pair="$(printf '%s\n' "$pem_diff" | sed -n "${pem_line_no},$((pem_line_no + 1))p")" || exit 1
		pem_header_line="${pem_pair%%$'\n'*}"
		pem_next_line=''
		case "$pem_pair" in *$'\n'*) pem_next_line="${pem_pair#*$'\n'}" ;; esac
		# Inline material counts only on an ADDED header. A committed header that already carries
		# key material is not what this commit is leaking, and reporting it would block every later
		# commit to that file with no way to clear it short of the bypass.
		if picks -Ei -e "^\+.*${pem_inline_pattern}" <<<"$pem_header_line" ||
			picks -E -e "$pem_body_pattern" <<<"$pem_next_line"; then
			printf 'key\n' || exit 1
		fi
	done
}
pem_patch="$(staged_patch 1)$decoded_pem" || exit 1
pem_hits="$(printf '%s\n' "$pem_patch" | pick -vE '^(\+\+\+|---)' | pem_scan)" || exit 1

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
self_name="$(git rev-parse --show-toplevel)" || exit 1; self_name="${self_name##*/}"
# A public site may advertise sibling products whose names are private everywhere else, and the
# self-name rule cannot express that. The tracked scripts/smokestack/leak-guard-publishes lists the
# names this repository is cleared to publish, one per line. It is read from the INDEX, so what
# governs a commit is what that commit's reviewer sees, not an unstaged local edit. A pattern is
# cleared only when it matches a listed name in full (-x), so one concatenated entry cannot clear
# two patterns. It clears tier 2 only; secret formats and home paths are never exempt, and each use
# is announced.
#
# The second read is the file's home before v0.6.0, kept for v0.6.0 only so a repository is not left
# unguarded between taking this file and moving its list. The release after v0.6.0 removes it.
publishes="$(
	{
		git show :scripts/smokestack/leak-guard-publishes 2>/dev/null || true
		git show :.githooks/leak-guard-publishes 2>/dev/null || true
	} | tr -d '\r' | grep -vE '^[[:space:]]*(#|$)' || true
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
	[ "$grep_status" -gt 1 ] && tier2_off 'local pattern file could not be read'
	# A file with no active line is a tier that is off, as surely as a missing file, and it used to
	# skip the private tier without a word. Patterns this repository's own name or its publishes
	# list clear are another matter: those are legitimate, and only announced below.
	[ -z "$active" ] && tier2_off 'local pattern file holds no pattern'
	# The filter runs in this shell, on a here-string, and keeps each pattern as a grep -e argument, so
	# no failed printf or subshell can drop one; only a match (status 0) clears a pattern.
	read_patterns="$active" active='' pattern_args=()
	while IFS= read -r pattern; do
		[ -z "$pattern" ] && continue
		cleared=0; grep -qEi -e "$pattern" <<<"$self_name" 2>/dev/null || cleared=$?
		[ "$cleared" = 0 ] && continue
		cleared=0; [ -n "$publishes" ] && grep -qxEi -e "$pattern" <<<"$publishes" 2>/dev/null || cleared=$?
		[ "$cleared" = 0 ] && echo "leak-guard: a private pattern is cleared for this repo by its leak-guard-publishes" >&2 && continue
		active="$active$pattern"$'\n' && pattern_args+=(-e "$pattern")
	done <<<"$read_patterns"
	[ -z "$read_patterns" ] || [ -n "$active" ] || echo "leak-guard: every private pattern is cleared for this repository (its own name or its leak-guard-publishes)" >&2
	if [ -n "$active" ]; then
		# grep exits 1 for no match and 2 when it cannot use a pattern; a pattern it cannot compile is
		# kept above so that it stops the commit here, rather than the private tier going silently off.
		grep_status=0
		local_hits="$(grep -nEi "${pattern_args[@]}" <<<"$added")" || grep_status=$?
		if [ "$grep_status" -gt 1 ]; then
			local_hits=''
			tier2_off 'a private pattern is not a valid expression, so none could be applied'
		fi
	fi
fi

# Says which staged files hold matching additions and how many, for one class of pattern.
# It never prints a matching line: the guard has just refused that text, and echoing it would copy
# the secret into the terminal and into whatever log captures the hook's output. This runs only
# when something was found, so an ordinary commit does not pay for the per-file pass.
#
# File names are printed, because without one nobody can find the line. The guard inspects added
# lines and has never inspected names, so a file named after a secret or a private name is not
# refused for its name, and git prints that name in its own output regardless.
count_class() {
	local class="$1" file="$2" dir=''
	# A decoded UTF-16 file is counted from what was decoded, since git's diff of it holds no lines.
	[ -n "${decoded:-}" ] && dir="$(decoded_dir_of "$file")"
	if [ "$class" = pem ]; then
		# The same walk that refused the commit, so a file is listed only if the rule fired in it.
		if [ -n "$dir" ]; then pem_scan <"$dir/pem" | grep -c . || true; return 0; fi
		git diff --cached --unified=1 --no-color --no-textconv -- "$file" | grep -vE '^(\+\+\+|---)' | pem_scan | grep -c . || true
		return 0
	fi
	{ if [ -n "$dir" ]; then cat "$dir/added"; else git diff --cached --unified=0 --no-color --no-textconv -- "$file" | grep -E '^\+' | grep -vE '^\+\+\+'; fi; } | case "$class" in
	secret) grep -cEi -e "$secret_pattern" ;;
	path) grep -cE -e "$path_pattern" ;;
	private) grep -cEi "${pattern_args[@]}" ;;
	esac || true
}
report_class() {
	local class="$1" label="$2" unit="$3" file count
	while IFS= read -r -d '' file; do
		count="$(count_class "$class" "$file")"
		if [ "${count:-0}" -gt 0 ]; then
			printf '  %s: %s %s, %s\n' "$file" "$count" "$unit" "$label" >&2
		fi
	done < <(git diff --cached --name-only -z --diff-filter=ACMR -- "${scanned[@]}")
}

if [ -n "$secret_hits$pem_hits$path_hits$local_hits$key_hits" ]; then
	echo "" >&2
	echo "x re-leak guard: staged changes contain forbidden private/secret patterns:" >&2
	if [ -n "$key_hits" ]; then
		# A name may hold control characters; shown raw they would drive the terminal.
		while IFS= read -r -d '' file; do
			printf '  %s: key file by name; unstage it and add it to .gitignore\n' \
				"$(printf '%s' "$file" | LC_ALL=C tr '\000-\037\177' '?')" >&2
		done < <(key_named_files)
	fi
	if [ -n "$secret_hits" ]; then report_class secret 'secret format' 'line(s)'; fi
	if [ -n "$pem_hits" ]; then report_class pem 'private key material' 'key(s)'; fi
	if [ -n "$path_hits" ]; then report_class path 'home-directory path' 'line(s)'; fi
	if [ -n "$local_hits" ]; then report_class private 'private name' 'line(s)'; fi
	echo "" >&2
	echo "  The matching lines are not shown, so a refused secret is not copied into this output." >&2
	echo "  See them with: git diff --cached -- <file>" >&2
	echo "  Scrub these before committing. A confirmed false positive is the user's" >&2
	echo "  call to make, not a reason to skip the hook." >&2
	exit 1
fi
exit 0
