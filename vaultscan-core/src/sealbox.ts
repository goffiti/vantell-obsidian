/**
 * libsodium `crypto_box_seal` interop, built from the Ed25519 identities the
 * protocol already distributes (build-spec §2: envelope bodies sealed to the
 * recipient's key; the relay stores ciphertext it cannot read).
 *
 * Format (libsodium):  sealed = epk(32) ‖ box
 *   box   = XSalsa20-Poly1305(k, nonce, msg)
 *   k     = HSalsa20(X25519(esk, rpk), 0¹⁶)          — crypto_box "beforenm"
 *   nonce = BLAKE2b-24(epk ‖ rpk)
 * with rpk = the recipient's Ed25519 public key converted to X25519, and the
 * recipient's X25519 secret derived from their Ed25519 seed — no new keys to
 * distribute. Pure @noble stack; validated against a PyNaCl-generated vector
 * in __tests__/sealbox.test.ts, so drift from libsodium fails the suite.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { blake2b } from '@noble/hashes/blake2.js';

const SIGMA = Uint32Array.from([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
const EPK_LEN = 32;
const TAG_LEN = 16;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesToU32(b: Uint8Array): Uint32Array {
  const out = new Uint32Array(b.length / 4);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

function u32ToBytes(w: Uint32Array): Uint8Array {
  const out = new Uint8Array(w.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < w.length; i++) dv.setUint32(i * 4, w[i]!, true);
  return out;
}

/** crypto_box_beforenm: HSalsa20 of the raw X25519 shared secret. */
function beforenm(shared: Uint8Array): Uint8Array {
  const out = new Uint32Array(8);
  hsalsa(SIGMA, bytesToU32(shared), new Uint32Array(4), out);
  return u32ToBytes(out);
}

function sealNonce(epk: Uint8Array, rpk: Uint8Array): Uint8Array {
  return blake2b(concat(epk, rpk), { dkLen: 24 });
}

/** Seal a UTF-8 string to a recipient identified by their Ed25519 public key
 * (base64, as published in their manifest). Returns base64(epk ‖ box). */
export function sealToRecipient(plaintext: string, recipientEdPubB64: string): string {
  const rpk = ed25519.utils.toMontgomery(b64ToBytes(recipientEdPubB64));
  const esk = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(esk);
  const key = beforenm(x25519.getSharedSecret(esk, rpk));
  const box = xsalsa20poly1305(key, sealNonce(epk, rpk)).encrypt(
    new TextEncoder().encode(plaintext),
  );
  return bytesToB64(concat(epk, box));
}

/** Open a sealed box with our Ed25519 seed (base64). Returns the UTF-8
 * plaintext, or null for anything that does not verify — the caller treats
 * null exactly like a foreign envelope. */
export function openSealed(sealedB64: string, edSeedB64: string): string | null {
  let sealed: Uint8Array;
  try {
    sealed = b64ToBytes(sealedB64);
  } catch {
    return null;
  }
  if (sealed.length < EPK_LEN + TAG_LEN) return null;
  const epk = sealed.slice(0, EPK_LEN);
  const box = sealed.slice(EPK_LEN);
  try {
    const xsk = ed25519.utils.toMontgomerySecret(b64ToBytes(edSeedB64));
    const rpk = x25519.getPublicKey(xsk);
    const key = beforenm(x25519.getSharedSecret(xsk, epk));
    const plain = xsalsa20poly1305(key, sealNonce(epk, rpk)).decrypt(box);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
