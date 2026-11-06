# Self-test for leak-guard.sh, cases 22 to 38: files git calls binary, read by leak-guard-decode.sh.
# Sourced by check-leak-guard.sh after check-leak-guard-cases.sh, never run alone: it uses that
# file's scratch repositories, fixtures (synthetic, aws_key, pem_header, b64_run, win_path), helpers
# (run_guard, fail) and failure count, and that file prints the summary and sets the exit code.
# Split from check-leak-guard-cases.sh so each stays under the 300-line ceiling.
#
# smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
# smokestack; every repository that takes it holds a byte-identical copy.
#
# SC2154 is off for this file only, for the same reason as in check-leak-guard-cases.sh: the
# variables it reads unassigned (aws_key, b64_run, guard, guard_repo, pem_header, synthetic, tmp,
# win_path) are set by check-leak-guard.sh before it sources this file.
# SC2016 is off too: the function bodies cases 34-38 hand the guard are single-quoted on purpose.
# shellcheck shell=bash disable=SC2154,SC2016

# 22-27. UTF-16 text is decoded for the content tiers (leak-guard-decode.sh); git calls it binary and
# shows no lines, so a secret saved as UTF-16 used to pass. Each case stages text.utf16 from $2,
# encoded as $1: le-bom, be-bom or le (no mark), and runs the guard with the synthetic patterns.
utf16_bytes() {
	case "$1" in
	le-bom) printf '\377\376'; printf '%s\n' "$2" | iconv -f UTF-8 -t UTF-16LE ;;
	be-bom) printf '\376\377'; printf '%s\n' "$2" | iconv -f UTF-8 -t UTF-16BE ;;
	le) printf '%s\n' "$2" | iconv -f UTF-8 -t UTF-16LE ;;
	be) printf '%s\n' "$2" | iconv -f UTF-8 -t UTF-16BE ;;
	esac
}
run_guard_utf16() {
	utf16_bytes "$1" "$2" >"$guard_repo/text.utf16"
	git -C "$guard_repo" add text.utf16
	local code=0
	(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
	git -C "$guard_repo" rm -q --cached text.utf16
	echo "$code"
}
# 22. A secret format in UTF-16 is refused, with or without a byte-order mark, in either order, and
# the refusal names the file and counts the line without printing it.
for encoding in le-bom be-bom le; do
	[ "$(run_guard_utf16 "$encoding" "key=$aws_key")" = 1 ] || fail "a UTF-16 ($encoding) secret was not refused"
done
grep -q 'text.utf16: 1 line(s), secret format' "$tmp/stderr" || fail 'a UTF-16 refusal did not name the file and the class'
if grep -q "$aws_key" "$tmp/stderr"; then fail 'a UTF-16 refusal printed the secret it refused'; fi
# 23. A private name and a home path in UTF-16 are refused too; clean UTF-16 text passes.
[ "$(run_guard_utf16 le 'mentions zzz-synthetic-app somewhere')" = 1 ] || fail 'a UTF-16 private name was not refused'
[ "$(run_guard_utf16 le-bom "path=$win_path")" = 1 ] || fail 'a UTF-16 home path was not refused'
[ "$(run_guard_utf16 le-bom 'plain harmless content')" = 0 ] || fail 'clean UTF-16 text was refused'
# 24. A PEM key body in UTF-16 is refused by the same rule as in UTF-8, and a bare header is not.
[ "$(run_guard_utf16 le-bom "$(printf '%s\n%s' "$pem_header" "$b64_run")")" = 1 ] || fail 'a UTF-16 PEM key body was not refused'
[ "$(run_guard_utf16 le-bom "expectedHeader: '$pem_header',")" = 0 ] || fail 'a bare UTF-16 PEM header was refused'
# 25. Only additions count: a committed UTF-16 file already holding a home path takes a clean line.
utf16_bytes le-bom "path=$win_path" >"$guard_repo/old.utf16"
git -C "$guard_repo" add old.utf16
git -C "$guard_repo" -c user.email=t@test -c user.name=t commit -q --no-verify -m 'committed utf16' -- old.utf16
utf16_bytes le-bom "$(printf '%s\n%s' "path=$win_path" 'a clean added line')" >"$guard_repo/old.utf16"
git -C "$guard_repo" add old.utf16
code=0
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 0 ] || fail 'a clean line added to a committed UTF-16 file was refused for what was there'
git -C "$guard_repo" rm -q -f old.utf16
git -C "$guard_repo" -c user.email=t@test -c user.name=t commit -q --no-verify -m 'drop utf16' -- old.utf16
# 26. Any other binary file is read as UTF-16 in both byte orders, says so, and passes when neither
# reading holds anything the tiers refuse.
printf '\000\107\120\107\001\377\020' >"$guard_repo/blob.bin"
git -C "$guard_repo" add blob.bin
code=0
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 0 ] || fail 'a clean binary file was refused'
grep -q 'blob.bin is binary; it was scanned as UTF-16 in both byte orders' "$tmp/stderr" || fail 'a binary file was not named in a notice'
# 27. Without its decoder beside it, a guard with a binary file staged refuses rather than pass it.
mv "$guard_repo/$(dirname "$guard")/leak-guard-decode.sh" "$tmp/decoder-aside"
code=0
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
mv "$tmp/decoder-aside" "$guard_repo/$(dirname "$guard")/leak-guard-decode.sh"
[ "$code" = 1 ] || fail 'a binary file passed with the decoder missing'
grep -q 'leak-guard-decode.sh is missing' "$tmp/stderr" || fail 'a missing decoder did not say why it refused'
git -C "$guard_repo" rm -q --cached blob.bin
rm -f "$guard_repo/blob.bin" "$guard_repo/text.utf16"

# 28. A committed .gitattributes cannot hide text: a UTF-8 file marked -diff, which git then shows as
# "Binary files differ", is still read as text (Roger #35607).
printf '%s\n' '*.txt -diff' >"$guard_repo/.gitattributes"
git -C "$guard_repo" add .gitattributes
[ "$(run_guard "$synthetic" "key=$aws_key")" = 1 ] || fail 'a secret in a text file marked -diff was not refused'
grep -q 'staged.txt: 1 line(s), secret format' "$tmp/stderr" || fail 'a -diff refusal did not name the file and the class'
git -C "$guard_repo" rm -q -f .gitattributes
# Restaged clean, so the cases after this one are refused, or not, for their own file alone.
printf '%s\n' 'plain harmless content' >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt

# 29. Without a byte-order mark, UTF-16 is found by reading the whole file in both orders, not a
# sample: text in another script fills more than the first 4 KB before the secret (Roger #35607).
prefix="$(printf 'Ж%.0s' $(seq 1 3000))"
for encoding in le be; do
	[ "$(run_guard_utf16 "$encoding" "$(printf '%s\n%s' "$prefix" "key=$aws_key")")" = 1 ] ||
		fail "a UTF-16 ($encoding, no mark) secret after a long non-ASCII head was not refused"
	grep -q 'text.utf16: 1 line(s), secret format' "$tmp/stderr" ||
		fail "a UTF-16 ($encoding, no mark) refusal did not name the file it was refused for"
done
rm -f "$guard_repo/text.utf16"

# 30. Decoded files are walked one at a time for PEM: a bare header in one and a base64 line in
# another are not a key, and are not refused as one (Roger #35667).
utf16_bytes le-bom "expectedHeader: '$pem_header'" >"$guard_repo/a.utf16"
utf16_bytes le-bom "$b64_run" >"$guard_repo/b.utf16"
git -C "$guard_repo" add a.utf16 b.utf16
code=0
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 0 ] || fail 'a PEM header and a base64 line in two different files were refused as a key'
git -C "$guard_repo" rm -q --cached a.utf16 b.utf16
rm -f "$guard_repo/a.utf16" "$guard_repo/b.utf16"

# 31. The same with the -diff attribute already committed, and the secret staged in a later commit.
printf '%s\n' '*.txt -diff' >"$guard_repo/.gitattributes"
git -C "$guard_repo" add .gitattributes
git -C "$guard_repo" -c user.email=t@test -c user.name=t commit -q --no-verify -m 'mark txt -diff' -- .gitattributes
[ "$(run_guard "$synthetic" "key=$aws_key")" = 1 ] || fail 'a secret staged under a committed -diff attribute was not refused'
grep -q 'staged.txt: 1 line(s), secret format' "$tmp/stderr" || fail 'a committed -diff refusal did not name the file and the class'
git -C "$guard_repo" rm -q -f .gitattributes
git -C "$guard_repo" -c user.email=t@test -c user.name=t commit -q --no-verify -m 'unmark txt' -- .gitattributes
printf '%s\n' 'plain harmless content' >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt

# 32-33. A tool the binary reader needs that cannot run refuses rather than reading nothing. An
# exported function stands in for the missing command, as reg.exe does above.
utf16_bytes le "key=$aws_key" >"$guard_repo/text.utf16"
git -C "$guard_repo" add text.utf16
for tool in iconv od; do
	code=0
	(
		# shellcheck disable=SC2317 # exported with export -f; the guard calls it in a child bash
		eval "$tool() { return 127; }"
		export -f "${tool?}"
		cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard"
	) 2>"$tmp/stderr" || code=$?
	[ "$code" = 1 ] || fail "a staged UTF-16 secret passed with $tool unavailable"
	grep -q 'x leak-guard:' "$tmp/stderr" || fail "a guard without $tool did not say why it refused"
done
git -C "$guard_repo" rm -q --cached text.utf16
rm -f "$guard_repo/text.utf16"

# 34-38. A step that fails while producing what a tier scans refuses, rather than leaving the tier
# nothing (Steward #35682). BASH_ENV, read by the guard's non-interactive bash, defines a function
# that fails one command for one kind of input and passes every other call through.
run_guard_failing() {
	printf '%s\n' "$1" >"$tmp/failing-env"
	local code=0
	(cd "$guard_repo" && BASH_ENV="$tmp/failing-env" LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
	echo "$code"
}
# 34. The grep that selects tier 1a hits. 35. The grep that selects PEM header lines.
printf '%s\n' "key=$aws_key" >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt
[ "$(run_guard_failing 'grep() { case "$*" in *AKIA*) return 2 ;; esac; command grep "$@"; }')" = 1 ] ||
	fail 'a failed tier 1a grep let a secret through'
grep -q 'grep failed' "$tmp/stderr" || fail 'a failed tier 1a grep did not say why it refused'
printf '%s\n%s\n' "$pem_header" "$b64_run" >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt
[ "$(run_guard_failing 'grep() { case "$*" in *"[+ ].*"*) return 2 ;; esac; command grep "$@"; }')" = 1 ] ||
	fail 'a failed PEM header grep let a key body through'
printf '%s\n' 'plain harmless content' >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt
# 36-38. In the binary reader, for a BOM-less UTF-16 secret: the line selection (36), diff (37) and
# git cat-file (38).
utf16_bytes le "key=$aws_key" >"$guard_repo/text.utf16"
git -C "$guard_repo" add text.utf16
[ "$(run_guard_failing 'grep() { case "$*" in */u0*) return 2 ;; esac; command grep "$@"; }')" = 1 ] ||
	fail 'a failed decoded-line grep let a UTF-16 secret through'
[ "$(run_guard_failing 'diff() { return 2; }')" = 1 ] || fail 'a failed diff let a UTF-16 secret through'
grep -q 'diff failed' "$tmp/stderr" || fail 'a failed diff did not say why it refused'
[ "$(run_guard_failing 'git() { [ "$1" = cat-file ] && [ "$2" = blob ] && return 128; command git "$@"; }')" = 1 ] ||
	fail 'a failed blob read let a UTF-16 secret through'
grep -q 'git could not read' "$tmp/stderr" || fail 'a failed blob read did not say why it refused'
git -C "$guard_repo" rm -q --cached text.utf16
rm -f "$guard_repo/text.utf16"
