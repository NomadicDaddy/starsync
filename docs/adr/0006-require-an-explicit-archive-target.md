# Require an explicit archive target

Every StarSync operation will require either a target-path argument or `TARGET_PATH` in the next major release. The current `<starsync-project>/starred_repos` fallback is deprecated until then. Requiring a target is less convenient for first-time use, but prevents a packaged or scheduled CLI from silently creating and modifying an archive inside its installation or an accidental working directory.
