# Trust immutable GitHub release assets

The updater will treat assets from the project's immutable GitHub releases as its trusted distribution boundary rather than introducing a separately signed project manifest or signing-key rotation scheme. A candidate still becomes a Verified Release only after a complete download, safe staging that rejects unsafe archive paths, and validation that required application files exist; corruption or staging failure must preserve the Last Known-Good Installation.
