#!/usr/bin/env bash
# Blocks a push that rewrites or deletes remote history when it is issued by an aidd agent.
#
# aidd marks every process that acts for an agent (an external coding CLI it launches, its own
# bash tool) with AIDD_AGENT=1. Those CLIs run with permission bypass, so aidd's bash deny-list
# never sees their shell and the prompt's prohibition on force-pushing is advice, not a control.
# This guard is the enforcement point: git runs it for every push from inside the repository,
# whichever shell issued the command, and it judges the ref update git is about to perform rather
# than the spelling of the command, so `+refspec`, `--force-with-lease`, an alias and a deletion
# are all caught. Outside an agent process the guard exits 0 and the operator's pushes are their
# own business.
#
# Reads the pre-push stdin protocol: <local-ref> <local-sha> <remote-ref> <remote-sha> per line.
#
#   - a zero local sha deletes the remote ref: refused.
#   - a zero remote sha creates the ref: nothing exists to rewrite, allowed.
#   - otherwise the remote tip must be an ancestor of what is pushed. A remote tip this
#     repository cannot resolve is treated the same way as a diverged one: a push over an
#     unfetched tip can only succeed by force, so refusing it loses nothing.
#
# Deliberately no override spelling is printed. An agent that needs remote history rewritten
# stops and says so; the operator runs the push from their own shell, where this guard is inert.
#
# Keep this file byte-identical between the aidd and spernakit repos.
set -euo pipefail

ZERO=0000000000000000000000000000000000000000

[ -n "${AIDD_AGENT:-}" ] || exit 0

problems=0
note() { echo "  $*" >&2; }

while read -r _local_ref local_sha remote_ref remote_sha; do
	[ -z "${local_sha:-}" ] && continue
	if [ "$local_sha" = "$ZERO" ]; then
		note "$remote_ref: this push deletes the remote ref"
		problems=1
		continue
	fi
	[ "$remote_sha" = "$ZERO" ] && continue
	# merge-base peels annotated tags itself; a tag moved to another commit is a rewrite too.
	# Exit 1 is a diverged history, exit 128 an unresolvable remote tip; both refuse.
	if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
		note "$remote_ref: the remote tip ${remote_sha:0:12} is not an ancestor of ${local_sha:0:12} (non-fast-forward)"
		problems=1
	fi
done

if [ "$problems" -ne 0 ]; then
	echo "" >&2
	echo "PUSH BLOCKED: this push rewrites or deletes remote history, and it was issued by an aidd agent (AIDD_AGENT is set)." >&2
	echo "An aidd run never rewrites a remote. Stop and report that the push needs the operator;" >&2
	echo "they can run it from their own shell, where this guard does not apply." >&2
	exit 1
fi

exit 0
