/**
 * Minimal, strictly-typed declarations for the subset of @noble/ed25519
 * this package uses. Vendored so type resolution works without
 * node_modules — the Obsidian directory's automated review lints without
 * installing dependencies.
 */
export function getPublicKeyAsync(privKey: Uint8Array): Promise<Uint8Array>;
export function signAsync(message: Uint8Array, privKey: Uint8Array): Promise<Uint8Array>;
export function verifyAsync(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean>;
