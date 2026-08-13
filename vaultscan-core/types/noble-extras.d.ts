/**
 * Minimal ambient declarations for the @noble modules sealbox.ts uses.
 * Vendored so type resolution works without node_modules (the Obsidian
 * directory's automated review lints without installing). Runtime
 * correctness is guarded separately by the PyNaCl cross-vector test.
 */
declare module '@noble/curves/ed25519.js' {
  export const ed25519: {
    utils: {
      toMontgomery(publicKey: Uint8Array): Uint8Array;
      toMontgomerySecret(secretKey: Uint8Array): Uint8Array;
    };
  };
  export const x25519: {
    getPublicKey(secretKey: Uint8Array): Uint8Array;
    getSharedSecret(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
    utils: {
      randomSecretKey(): Uint8Array;
    };
  };
}

declare module '@noble/ciphers/salsa.js' {
  export function hsalsa(
    s: Uint32Array,
    k: Uint32Array,
    i: Uint32Array,
    out: Uint32Array,
  ): void;
  export function xsalsa20poly1305(
    key: Uint8Array,
    nonce: Uint8Array,
  ): {
    encrypt(plaintext: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array): Uint8Array;
  };
}

declare module '@noble/hashes/blake2.js' {
  export function blake2b(msg: Uint8Array, opts?: { dkLen?: number }): Uint8Array;
}
