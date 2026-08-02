# Store identity with each checkout

Each managed checkout stores its GitHub repository ID and last-known slug in its local Git configuration. This makes the checkout self-identifying when its folder is moved and lets StarSync detect duplicate identities while scanning an archive. A central archive manifest was rejected because it can drift from the folders it describes and creates a second record that must be kept in sync.

Format 2 requires both identity values to exist and be valid. Synchronization, verification, and rename treat missing, incomplete, invalid, or duplicated identities as errors. Rename also requires the stored repository ID to match GitHub's resolved ID and changes only the slug, origin, and folder label.
