#!/usr/bin/env bash
# Re-leak guard for the public repository (two tiers).
#
# Tier 1 (tracked, below): generic high-signal secret formats and
# home-directory path shapes. Nothing machine- or fleet-specific.
# Tier 2 (untracked): private literals loaded from LEAK_GUARD_PATTERNS, else
# the Windows user-level value of the same name, else
# $HOME/.config/leak-guard/patterns (extended regexes, one per line; blank
# lines and # comments ignored). Seeded by leak-guard-setup.sh beside it
# (runs via the `prepare` script). Tier 2 WARNS: each matching added line is
# reported as `leak-guard warning: <file>:<line>: internal reference: ...` with
# a count line, and the commit is not refused for it, because a private name
# is a judgement call (make it generic, or confirm the use), not a secret
# (leak-guard-private-tier-warns, Phillip via Steward #63083). A broken setup
# still fails closed: a configured file that is missing, empty, unreadable or
# holds a pattern grep cannot compile stops the commit unless
# LEAK_GUARD_ALLOW_NO_PRIVATE=1 is set for it; with nothing configured the
# guard says so and runs tier 1 only.
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
# Every "${name[@]}" in the guard's files either carries a `nonempty:` reason on its line or the line
# above, as scanned's do (it starts as (.) and is only appended to), or is written ${name[@]+...}.
# bash 3.2, which macOS ships, stops on an empty array expanded bare under set -u; the self-test
# refuses an expansion with neither (leak-guard-bash-3-2-empty-pattern-array).

# Tier 1c: key files by name. A binary or encrypted key (DER .key, PKCS#12/#8, PuTTY, a keystore, a
# wrapped PEM) has no header for the content scan. A bare .gpg or .pgp is refused, since nothing in
# it names what it wraps; .asc (mostly signatures) and .der (as often a public certificate) are not.
# A deletion is never refused. There is no exemption list (design review #17104).
key_name_pattern='\.(pem|key|p12|pfx|p8|ppk|jks|keystore)(\.(gpg|asc|pgp|age|enc))?$|\.(gpg|pgp)$'
# Prints each staged file whose last path segment is key-shaped, NUL-terminated; -z keeps a name
# with a newline, quotes or non-ASCII whole, and T counts a symlink that became a file.
key_named_files() {
	local file
	# A pipeline, not < <(…): under pipefail a failed listing fails this function, and its caller. The
	# loop cannot tell an unlistable index from an empty one, so the listing itself refuses.
	{
		# nonempty: scanned starts as (.).
		git diff --cached --name-only -z --diff-filter=ACMRT -- "${scanned[@]}" ||
			{ echo "x leak-guard: git could not list the staged files, so key file names were not checked." >&2; exit 1; }
	} | while IFS= read -r -d '' file; do
		if picks -Ei -e "$key_name_pattern" <<<"${file##*/}"; then printf '%s\0' "$file" || exit 1; fi
	done
}
key_hits="$(key_named_files | tr '\0' '\n')" || exit 1

# The staged patch is read whole and its exit checked: piped, a failed one left the tiers nothing.
staged_patch() {
	# nonempty: scanned starts as (.).
	if ! git diff --cached --unified="$1" --no-color --no-textconv -- "${scanned[@]}"; then
		echo "x leak-guard: git could not produce the staged changes, so their content was not checked." >&2
		exit 1
	fi
}
# Headers run from `diff --git` to the first `@@` and are the only lines dropped: content starting ++
# reads `+++…`, and was dropped unscanned with them (Morticia, 7f2bc58). One patch, one context line.
hunks() { awk '/^diff --git /{h=1} h&&/^@@/{h=0} !h' || exit 1; }
patch="$(staged_patch 1)" || exit 1
added="$(printf '%s\n' "$patch" | hunks | pick -E '^\+')" || exit 1
# A file git calls binary adds no lines here: leak-guard-decode.sh, beside this one, reads it instead.
# nonempty: scanned starts as (.).
numstat="$(git diff --cached --numstat -- "${scanned[@]}")" || exit 1
decoded_pem=''
case $'\n'"$numstat" in *$'\n-\t-\t'*)
	decoder="$(dirname "$0")/leak-guard-decode.sh"
	if [ ! -f "$decoder" ]; then
		echo "x leak-guard: binary files are staged and $decoder is missing, so they were not checked." >&2
		exit 1
	fi
	# With -x, ShellCheck follows the decoder through SCRIPTDIR; a plain run follows no sourced file.
	# shellcheck source-path=SCRIPTDIR source=leak-guard-decode.sh disable=SC1091
	. "$decoder"
	trap '[ -n "$decoded" ] && rm -rf "$decoded"' EXIT
	decode_staged_binaries
	# shellcheck disable=SC2154 # set by decode_staged_binaries in leak-guard-decode.sh
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

# The PEM walk reads a diff with one line of context, not $added: a body pasted under a committed
# header (the likeliest leak) pairs an addition with a context line. pem_scan prints one per key.
pem_scan() {
	local pem_diff pem_header_lines pem_line_no pem_pair pem_header_line pem_next_line
	# Removed lines and "\ No newline" markers are not in the staged file, so the next line kept is
	# the one after the header there (Roger, 887d656).
	pem_diff="$(pick -vE '^(-|\\)')" || exit 1
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
pem_patch="$patch$decoded_pem"
pem_hits="$(printf '%s\n' "$pem_patch" | hunks | pem_scan)" || exit 1

# Tier 2 lives in leak-guard-private.sh beside this file, sourced so it reads $added and sets
# local_hits. Missing, the private tier could not run, so the commit stops.
private_module="$(dirname "$0")/leak-guard-private.sh"
if [ ! -f "$private_module" ]; then
	echo "x leak-guard: $private_module is missing, so the private tier could not run." >&2
	exit 1
fi
# shellcheck source-path=SCRIPTDIR source=leak-guard-private.sh disable=SC1091
. "$private_module"

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
		git diff --cached --unified=1 --no-color --no-textconv -- "$file" | hunks | pem_scan | grep -c . || true
		return 0
	fi
	{ if [ -n "$dir" ]; then cat "$dir/added"; else git diff --cached --unified=0 --no-color --no-textconv -- "$file" | hunks | grep -E '^\+'; fi; } | case "$class" in
	secret) grep -cEi -e "$secret_pattern" ;;
	path) grep -cE -e "$path_pattern" ;;
	esac || true
}
report_class() {
	local class="$1" label="$2" unit="$3" file count
	while IFS= read -r -d '' file; do
		count="$(count_class "$class" "$file")"
		if [ "${count:-0}" -gt 0 ]; then
			printf '  %s: %s %s, %s\n' "$file" "$count" "$unit" "$label" >&2
		fi
		# nonempty: scanned starts as (.).
	done < <(git diff --cached --name-only -z --diff-filter=ACMR -- "${scanned[@]}")
}

# Tier 2 warns and never refuses on its own (leak-guard-private-tier-warns).
[ -n "$local_hits" ] && warn_private
if [ -n "$secret_hits$pem_hits$path_hits$key_hits" ]; then
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
	echo "" >&2
	echo "  The matching lines are not shown, so a refused secret is not copied into this output." >&2
	echo "  See them with: git diff --cached -- <file>" >&2
	echo "  Scrub these before committing. A confirmed false positive is the user's" >&2
	echo "  call to make, not a reason to skip the hook." >&2
	exit 1
fi
exit 0
