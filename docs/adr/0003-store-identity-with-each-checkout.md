# Store identity with each checkout

Each managed checkout stores its GitHub repository ID and last-known slug in its local Git configuration. This makes the checkout self-identifying when its folder is moved and lets StarSync detect duplicate identities while scanning an archive. A central archive manifest was rejected because it can drift from the folders it describes and creates a second record that must be kept in sync. The explicit migration operation backfills identity for legacy checkouts only when the user applies its preview.
