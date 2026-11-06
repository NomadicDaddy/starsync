# Binary staged files for leak-guard.sh, which sources this from its own folder when git calls a
# staged file binary. Never run alone.
#
# git shows such a file as "Binary files differ", so the content tiers saw nothing in it: a secret
# saved as UTF-16, or in a text file a committed .gitattributes marks -diff, passed. Each file git
# calls binary is read here and its added lines handed to the tiers like any other:
#   - a file holding no NUL byte is text whatever its attributes say, and is diffed as text;
#   - a file starting with a UTF-16 byte-order mark is decoded in that order, and refused if it
#     cannot be;
#   - any other file is decoded whole as UTF-16 in both byte orders, dropping what does not decode,
#     and both readings are scanned. A sample cannot decide this: text in another script before an
#     ASCII secret leaves no NUL pattern in the head, and the secret would sit past it.
# Tier 1c still refuses key files by name. The added lines come from comparing the HEAD and staged
# readings, and a file with no HEAD version at its path (added, renamed or copied) is read whole.
# CR is stripped after decoding, so anchored patterns behave as they do for UTF-8. git's textconv
# is never applied. Decoded content stays in a folder only this user can read, removed on exit.
#
# Design reviewed by Morticia (#35603) and Roger (#35607). smokestack owns this file and delivers
# it beside leak-guard.sh with `bun run shared-core:write`. Like that file it must run under bash
# 3.2; it uses od, iconv and diff, which Git for Windows, macOS and Linux all ship.
# shellcheck shell=bash disable=SC2154 # scanned is set by leak-guard.sh before it sources this file


# Refuses with a reason, for a step whose failure would leave the content tiers nothing to scan.
decode_refuse() {
	echo "x leak-guard: $1, so the staged content was not checked." >&2
	exit 1
}

# Prints each staged file git counts as binary (numstat "-"), NUL-terminated, from listing file $1.
# A rename's record carries an empty path field followed by the old and new names; the new one is
# what is staged.
binary_staged_files() {
	local record counts path
	while IFS= read -r -d '' record; do
		counts="${record%$'\t'*}"
		path="${record##*$'\t'}"
		if [ -z "$path" ]; then
			# The old name, then the new one, which is read over it.
			IFS= read -r -d '' path || break
			IFS= read -r -d '' path || break
		fi
		if [ "$counts" = "-"$'\t'"-" ]; then printf '%s\0' "$path" || return 1; fi
	done <"$1"
}

# How the blob saved at $1 is read: text (no NUL byte), le-bom, be-bom, or utf16 for any other.
reading_of() {
	local status=0 nul bom
	# The bytes go to a file, and each step's status is checked: a failed od, or a grep that could not
	# read, would otherwise count no NUL and call a UTF-16 file text (Roger #35674). grep -c exits 1
	# for a count of 0, which is the answer, not a failure. A file and not grep -q, because an early
	# exit makes od die of SIGPIPE.
	od -An -v -tx1 "$1" >"$1.hex" || decode_refuse "od could not read a staged binary file"
	nul="$(grep -c ' 00' "$1.hex")" || status=$?
	[ "$status" -gt 1 ] && decode_refuse "grep could not read a staged binary file"
	if [ "$nul" = 0 ]; then
		echo text
		return 0
	fi
	# The byte-order probe is read into a variable first: a case word ignores its substitution's
	# status, so a failed head, od or tr gave an empty word and read the file as utf16 (Roger #36210).
	# The assignment takes the pipeline's status, which pipefail (set by leak-guard.sh) makes any
	# stage's failure.
	bom="$(head -c 2 "$1" | od -An -tx1 | tr -d ' \n')" ||
		decode_refuse "the byte-order probe could not read a staged binary file"
	case "$bom" in
	fffe) echo le-bom ;;
	feff) echo be-bom ;;
	*) echo utf16 ;;
	esac
}

# Writes the blob saved at $1, read as $2, to stdout as UTF-8 text with CR removed. A marked file is
# decoded strictly; an unmarked one is decoded in both orders, dropping what does not decode (iconv -c
# exits 1 for that, which is expected; more is a failure). Any failure returns non-zero. Every caller
# runs this under `||`, where set -e is off, so each command's status is checked here by hand
# (Roger #35689: a failed tr was hidden by the printf after it).
read_blob() {
	local status order
	case "$2" in
	text) tr -d '\r' <"$1" || return 1 ;;
	le-bom | be-bom) iconv -f UTF-16 -t UTF-8 <"$1" | tr -d '\r' || return 1 ;;
	utf16)
		for order in UTF-16LE UTF-16BE; do
			status=0
			iconv -c -f "$order" -t UTF-8 <"$1" >"$1.$order" || status=$?
			[ "$status" -gt 1 ] && return 1
			tr -d '\r' <"$1.$order" || return 1
			printf '\n' || return 1
		done
		;;
	*) return 1 ;;
	esac
}

# Writes the diff, with $1 lines of context, of files $2 and $3 to $4 without its file headers. Hunk
# headers stay, so lines from two hunks are never read as adjacent. diff exits 1 when the files
# differ, the expected case; 2 is a failure, and refuses. Called in this shell and never in a
# pipeline, so that the refusal stops the guard.
added_diff() {
	local status=0
	diff -U"$1" "$2" "$3" >"$4.raw" || status=$?
	[ "$status" -gt 1 ] && decode_refuse 'diff failed on a staged binary file'
	select_lines -vE '^(\+\+\+|---)' "$4.raw" >"$4"
}

# grep, where exit 1 (no line selected) is an answer and 2 (it could not read) refuses. Called in
# this shell, so the refusal stops the guard.
select_lines() {
	local status=0
	grep "$@" || status=$?
	[ "$status" -gt 1 ] && decode_refuse 'grep could not read a staged binary file'
	return 0
}

# Reads every staged file git calls binary into a folder under $decoded (its path, its added lines,
# and its diff with one line of context for the PEM walk), and appends those to decoded_added and
# decoded_pem, each file's PEM diff behind a boundary line so no two files' lines are adjacent.
# Refuses when git cannot list or read a blob, or a marked UTF-16 file does not decode.
decoded=''
decoded_added=''
decoded_pem=''
decode_staged_binaries() {
	local file reading head_reading index=0 dir safe
	decoded="$(umask 077 && mktemp -d)"
	git diff --cached --numstat -z --no-textconv --diff-filter=ACMRT -- "${scanned[@]}" >"$decoded/numstat" ||
		decode_refuse 'git could not list the staged binary files'
	# Written to a file, not read through < <(…), whose failure the loop could not see.
	binary_staged_files "$decoded/numstat" >"$decoded/binaries" || decode_refuse 'the staged binary files could not be listed'
	while IFS= read -r -d '' file; do
		safe="$(printf '%s' "$file" | LC_ALL=C tr '\000-\037\177' '?')"
		index=$((index + 1))
		dir="$decoded/$index"
		(umask 077 && mkdir "$dir")
		printf '%s' "$file" >"$dir/path"
		git cat-file blob ":$file" >"$dir/staged" || decode_refuse "git could not read $safe"
		# reading_of runs in a subshell here, so its refusal is passed on, and no reading is no pass.
		reading="$(reading_of "$dir/staged")" || exit 1
		[ -n "$reading" ] || decode_refuse "$safe could not be classified"
		read_blob "$dir/staged" "$reading" >"$dir/new" || decode_refuse "$safe is UTF-16 and could not be decoded"
		# A file with no HEAD version at its path (added, renamed or copied) is compared against
		# nothing, so all of it is scanned. An older version the guard cannot read is treated the same.
		: >"$dir/old"
		if git cat-file -e "HEAD:$file" 2>/dev/null && git cat-file blob "HEAD:$file" >"$dir/head"; then
			head_reading="$(reading_of "$dir/head")" || exit 1
			read_blob "$dir/head" "$head_reading" >"$dir/old" || : >"$dir/old"
		fi
		added_diff 0 "$dir/old" "$dir/new" "$dir/u0"
		select_lines -E '^\+' "$dir/u0" >"$dir/added"
		added_diff 1 "$dir/old" "$dir/new" "$dir/pem"
		decoded_added="$decoded_added"$'\n'"$(cat "$dir/added")"
		decoded_pem="$decoded_pem"$'\n@@ binary file boundary @@\n'"$(cat "$dir/pem")"
		[ "$reading" = utf16 ] && echo "leak-guard: $safe is binary; it was scanned as UTF-16 in both byte orders" >&2
	done <"$decoded/binaries"
	return 0
}

# The decoded folder of staged file $1, or nothing when it was not decoded.
decoded_dir_of() {
	local dir
	[ -n "$decoded" ] || return 0
	for dir in "$decoded"/*/; do
		if [ "$(cat "${dir}path")" = "$1" ]; then
			printf '%s' "${dir%/}"
			return 0
		fi
	done
}
