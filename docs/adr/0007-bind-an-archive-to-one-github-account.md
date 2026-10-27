# Bind an archive to one GitHub account

Extended by [ADR 0010](0010-bind-archives-to-one-forge-host.md): each archive binds one account
on one host, GitHub or Codeberg. The single-account invariant still applies.

Each managed archive records one immutable account ID on its selected host and rejects synchronization with a credential belonging to another account. Account login changes are accepted when the ID still matches.

The archive-level `.starsync/config.json` stores `archiveFormat`, the owner's numeric `id` and recorded `login`, and an optional `host`. New archives write the host explicitly; its absence means GitHub. Repository identities remain with their checkouts.

Supporting multiple accounts in one archive was rejected because changing credentials would otherwise make one account's repositories appear unstarred while silently adding another account's collection.
