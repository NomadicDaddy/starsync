# Store identity with each checkout

Extended by [ADR 0010](0010-bind-archives-to-one-forge-host.md): these IDs are scoped to the
archive's GitHub or Codeberg host. Rename now resolves the stored numeric ID on that host.

Each managed checkout stores its host-assigned repository ID and last-known slug in its local Git configuration as `starsync.repository-id` and `starsync.repository-slug`. This makes the checkout self-identifying when its folder is moved and lets StarSync detect duplicate identities while scanning an archive. A central archive manifest was rejected because it can drift from the folders it describes and creates a second record that must be kept in sync.

Format 2 requires both identity values to exist and be valid. Synchronization, verification, and rename treat missing, incomplete, invalid, or duplicated identities as errors. Rename also requires the stored repository ID to match the selected host's resolved ID and changes only the slug, origin, and folder label, preserving the stable ID. Successful synchronization also updates the stored slug and origin without moving the folder.

Forced verification can replace a checkout with missing identity only when its canonical folder resolves uniquely to an unclaimed repository ID. It validates a fresh clone before replacement and never backfills identity into the existing anomalous checkout.
