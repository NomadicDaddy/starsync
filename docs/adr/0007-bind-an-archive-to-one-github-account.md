# Bind an archive to one GitHub account

Extended by [ADR 0010](0010-bind-archives-to-one-forge-host.md): each archive binds one account
on one host, GitHub or Codeberg. The single-account invariant still applies.

Each managed archive records one immutable GitHub account ID and rejects synchronization with a credential belonging to another account. The archive-level configuration stores only that account identity and its own format version; repository identities remain with their checkouts. Supporting multiple accounts in one archive was rejected because changing credentials would otherwise make one account's repositories appear unstarred while silently adding another account's collection.
