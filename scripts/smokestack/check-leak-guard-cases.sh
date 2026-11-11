# Self-test for leak-guard.sh, cases 11 to 21. Sourced by check-leak-guard.sh, never run alone: it
# uses that file's scratch repositories, fixtures (synthetic, aws_key, pem_header, b64_run), helpers
# (run_guard, fail) and failure count, and that file prints the summary and sets the exit code.
# Split from check-leak-guard.sh so each stays under the 300-line ceiling.
#
# smokestack owns this file and delivers it with `bun run shared-core:write`. Change it in
# smokestack; every repository that takes it holds a byte-identical copy.
#
# SC2154 is off for this file only: the eight variables it reads unassigned (aws_key, b64_run,
# guard, guard_repo, hook, pem_header, synthetic, tmp) are set by check-leak-guard.sh before it
# sources this file, and a consumer that lints each file alone with shellcheck would otherwise fail
# on all of them. A misspelt name still fails the self-test, through the parent's set -u. A
# disable placed before the first command applies to the whole file; it is kept file-wide rather
# than narrowed behind a dummy command.
# shellcheck shell=bash disable=SC2154

# 13. A refusal names the file and counts the lines, and never repeats what it refused. The guard
# has just stopped that text from being committed; printing it would copy the secret into the
# terminal and into any log that captures the hook's output.
[ "$(run_guard "$synthetic" "key=$aws_key")" = 1 ] || fail 'synthetic AWS key was not blocked (case 13)'
grep -q 'staged.txt: 1 line(s), secret format' "$tmp/stderr" || fail 'a refusal did not name the file and the class'
if grep -q "$aws_key" "$tmp/stderr"; then fail 'a refusal printed the secret it refused'; fi
[ "$(run_guard "$tmp/patterns-pair" 'mentions zzz-sibling-app somewhere')" = 1 ] || fail 'sibling name was not blocked (case 13)'
grep -q 'staged.txt: 1 line(s), private name' "$tmp/stderr" || fail 'a private-name refusal did not name the file and the class'
if grep -q 'zzz-sibling-app' "$tmp/stderr"; then fail 'a refusal printed the private name it refused'; fi

# 14. A private pattern that is not a valid expression stops the commit. It is kept in the list on
# purpose so that it fails closed; when the error was swallowed the whole private tier reported no
# hits and passed. The per-commit override still lets the user commit on tier 1 alone.
printf '%s\n' '\bzzz-sibling-app\b' '[zzz-unclosed' >"$tmp/patterns-broken"
[ "$(run_guard "$tmp/patterns-broken" 'plain harmless content')" = 1 ] || fail 'an invalid private pattern let a commit through'
grep -q 'not a valid expression' "$tmp/stderr" || fail 'an invalid private pattern did not say why it refused'
code=0
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$tmp/patterns-broken" LEAK_GUARD_ALLOW_NO_PRIVATE=1 bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 0 ] || fail 'the per-commit override did not allow a commit past an invalid private pattern'

# 15. A refusal for a private key names only the file that holds one. A second staged file that
# merely shows the header, the shape a key takes, is not what was refused, and listing it would
# send whoever cleans up to the wrong file.
printf '%s\n' "$pem_header" >"$guard_repo/shape.txt"
git -C "$guard_repo" add shape.txt
[ "$(run_guard "$synthetic" "$(printf '%s\n%s' "$pem_header" "$b64_run")")" = 1 ] || fail 'a key beside a bare header was not blocked'
grep -q 'staged.txt: 1 key(s), private key material' "$tmp/stderr" || fail 'a key refusal did not name the file holding the key'
if grep -q 'shape.txt' "$tmp/stderr"; then fail 'a key refusal named a file that only shows a bare header'; fi
git -C "$guard_repo" rm -q --cached shape.txt
rm -f "$guard_repo/shape.txt"

# 12. A public site may publish a sibling's name once the repo's staged leak-guard-publishes clears
# it, and the guard says it did. The file is read from the index, so an unstaged edit clears nothing.
publishes_path=scripts/smokestack/leak-guard-publishes
publishes="$guard_repo/$publishes_path"
printf '%s\n' '# names this repo may publish' 'zzz-sibling-app' >"$publishes"
[ "$(run_guard "$tmp/patterns-pair" 'mentions zzz-sibling-app somewhere')" = 1 ] || fail 'an unstaged publishes file cleared a pattern'
git -C "$guard_repo" add "$publishes_path"
[ "$(run_guard "$tmp/patterns-pair" 'mentions zzz-sibling-app somewhere')" = 0 ] || fail 'a staged publishes entry did not clear its pattern'
grep -q 'cleared for this repo' "$tmp/stderr" || fail 'a cleared pattern was not announced'

# 12b. Clearing one name leaves every other private pattern armed, and never touches tier 1.
[ "$(run_guard "$tmp/patterns-pair" 'mentions zzz-synthetic-app somewhere')" = 1 ] || fail 'publishes cleared a name it does not list'
[ "$(run_guard "$tmp/patterns-pair" "key=$aws_key")" = 1 ] || fail 'publishes disarmed a tier-1 secret check'

# 12c. An entry must match a pattern in full, so a longer entry that merely contains a private name
# clears nothing. The entry is committed first: staged, its own added line would trip the guard and
# the case would pass whether or not the full-match rule held.
printf '%s\n' 'zzz-sibling-app-and-more' >"$publishes"
git -C "$guard_repo" add "$publishes_path"
git -C "$guard_repo" -c user.email=t@test -c user.name=t commit -q -m 'publishes entry'
[ "$(run_guard "$tmp/patterns-pair" 'mentions zzz-sibling-app somewhere')" = 1 ] || fail 'a longer publishes entry cleared a pattern it only contains'
git -C "$guard_repo" rm -q "$publishes_path"
git -C "$guard_repo" -c user.email=t@test -c user.name=t commit -q -m 'drop publishes entry'

# 12d. v0.6.0 only: the list is still read where it was kept before, .githooks/leak-guard-publishes,
# so a repository that has not moved it yet is not left refusing what it publishes. The release
# after v0.6.0 drops that read, and this case with it.
old_publishes_path=.githooks/leak-guard-publishes
mkdir -p "$guard_repo/.githooks"
printf '%s\n' 'zzz-sibling-app' >"$guard_repo/$old_publishes_path"
git -C "$guard_repo" add "$old_publishes_path"
[ "$(run_guard "$tmp/patterns-pair" 'mentions zzz-sibling-app somewhere')" = 0 ] || fail 'the list at its old path did not clear its pattern'
git -C "$guard_repo" rm -q --cached "$old_publishes_path"
rm -rf "$guard_repo/.githooks"

# 16. The guard does not scan itself, wherever it is installed: it spells out what it looks for.
# Found by asking git where it is, so a copy staged at scripts/smokestack/hooks is left out.
printf '%s\n' '# mentions zzz-sibling-app' >>"$guard_repo/$guard"
git -C "$guard_repo" add "$guard"
[ "$(run_guard "$tmp/patterns-pair" 'plain harmless content')" = 0 ] || fail 'the guard scanned its own staged copy'
git -C "$guard_repo" rm -q --cached "$guard"
cp "$hook" "$guard_repo/$guard"

# 11. A body pasted under a header that is ALREADY COMMITTED is blocked. The header is not an
# addition in that commit, so a scan of additions alone cannot see the pair, and pasting a body
# under a placeholder header left behind earlier is the likeliest way this leak actually happens.
# Last because it is the only case that commits, and every case above stages against HEAD.
[ "$(run_guard "$synthetic" "$pem_header")" = 0 ] || fail 'bare PEM header was blocked before the commit'
git -C "$guard_repo" -c user.email=t@test -c user.name=t commit -q -m 'header only'
[ "$(run_guard "$synthetic" "$(printf '%s\n%s' "$pem_header" "$b64_run")")" = 1 ] || fail 'body added under a committed PEM header was not blocked'

# 17. Tier 1c: a key file is refused by NAME even though its content matches no pattern and adds no
# text line. A PEM header cannot appear in a gpg-wrapped key, so this is the only tier that can
# catch it. staged.txt is first restaged clean: case 11 left the pasted key body in the index, and
# it would refuse every later case for its own reason. The bytes carry a NUL so git treats the file
# as binary (a real encrypted key's shape) and the staged diff adds no text line; printed through
# an octal-escape pipeline so this file never holds a real key shape.
printf '%s\n' 'plain harmless content' >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt
mkdir -p "$guard_repo/secrets"
printf '\000\107\120\107\001' >"$guard_repo/secrets/vendor_private_key.pem.gpg"
git -C "$guard_repo" add secrets/vendor_private_key.pem.gpg
code=0
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 1 ] || fail 'a gpg-wrapped key file was not refused by name'
grep -q 'key file by name' "$tmp/stderr" || fail 'a key-name refusal did not say what it refused'
git -C "$guard_repo" rm -q --cached secrets/vendor_private_key.pem.gpg
rm -rf "$guard_repo/secrets"

# 17b. A name the pattern does not cover, with the same NUL-bearing bytes, passes: the refusal is
# governed by the name pattern alone, not by the file being binary.
printf '\000\107\120\107\001' >"$guard_repo/binary-blob.bin"
git -C "$guard_repo" add binary-blob.bin
code=0
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 0 ] || fail 'an uncovered binary name was refused'
git -C "$guard_repo" rm -q --cached binary-blob.bin
rm -f "$guard_repo/binary-blob.bin"

# 18. A guard that cannot LIST the staged names has not checked them, so it refuses and says why
# (the failed-listing branch of tier 1c, previously untested): a GIT_INDEX_FILE that exists but is a
# directory makes every index read fail without touching the scratch repository's own index.
mkdir -p "$tmp/bogus-index"
printf '%s\n' 'plain harmless content' >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt
code=0
(cd "$guard_repo" && GIT_INDEX_FILE="$tmp/bogus-index" LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 1 ] || fail 'a failed staged-name listing let a commit through'
grep -q 'could not list the staged files' "$tmp/stderr" || fail 'a failed listing did not say why it refused'

# 19. A guard that can list the staged names but cannot read what they hold has not checked the
# content, so it refuses. The names come from the index alone; the patch needs each blob, so a
# staged blob removed from the object store fails only the patch. This is a repository of its own,
# since it is left corrupt. The working-tree copy goes too: while it still matches the index, git's
# diff reads it instead of the blob, so the patch succeeded and the guard refused the synthetic key
# instead. Git for Windows' core.autocrlf had hidden that; beazley.org's Linux build showed it.
make_repo unreadable-blob
printf '%s\n' "key=$aws_key" >"$tmp/unreadable-blob/staged.txt"
git -C "$tmp/unreadable-blob" add staged.txt
blob="$(git -C "$tmp/unreadable-blob" rev-parse :staged.txt)"
rm -f "$tmp/unreadable-blob/.git/objects/${blob:0:2}/${blob:2}" "$tmp/unreadable-blob/staged.txt"
code=0
(cd "$tmp/unreadable-blob" && LEAK_GUARD_PATTERNS="$synthetic" bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 1 ] || fail 'a staged blob git could not read let a commit through'
grep -q 'could not produce the staged changes' "$tmp/stderr" || fail 'an unreadable staged patch did not say why it refused'

# 20. A configured pattern file with no active line (empty, or only comments and blanks) is a private
# tier that is off, and is refused like a missing one. The per-commit override still lets it through,
# and says so.
printf '%s\n' '# comments only' '' '   ' >"$tmp/patterns-inert"
[ "$(run_guard "$tmp/patterns-inert" 'plain harmless content')" = 1 ] || fail 'a pattern file with no pattern let a commit through'
grep -q 'local pattern file holds no pattern' "$tmp/stderr" || fail 'an inert pattern file did not say why it refused'
: >"$tmp/patterns-empty"
[ "$(run_guard "$tmp/patterns-empty" 'plain harmless content')" = 1 ] || fail 'an empty pattern file let a commit through'
code=0
printf '%s\n' 'plain harmless content' >"$guard_repo/staged.txt"
git -C "$guard_repo" add staged.txt
(cd "$guard_repo" && LEAK_GUARD_PATTERNS="$tmp/patterns-inert" LEAK_GUARD_ALLOW_NO_PRIVATE=1 bash "$guard") 2>"$tmp/stderr" || code=$?
[ "$code" = 0 ] || fail 'LEAK_GUARD_ALLOW_NO_PRIVATE=1 did not let a commit through with an inert pattern file'
grep -q 'generic checks only' "$tmp/stderr" || fail 'the override did not warn that tier 2 was off for an inert pattern file'

# 21. Patterns this repository's own name clears are legitimate, not an inert file: the commit passes
# and the guard says, once, that every private pattern was cleared here.
guard_repo="$tmp/zzz-synthetic-app"
[ "$(run_guard "$synthetic" 'plain harmless content')" = 0 ] || fail 'a repository whose own name clears every pattern was refused'
grep -q 'every private pattern is cleared for this repository' "$tmp/stderr" || fail 'clearing every pattern was not announced'
guard_repo="$tmp/repo"
