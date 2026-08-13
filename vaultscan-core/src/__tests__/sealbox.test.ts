import { describe, expect, it } from 'vitest';
import { openSealed, sealToRecipient } from '../sealbox';
import { generateIdentity } from '../identity';

/**
 * Ground truth generated with PyNaCl (libsodium bindings):
 *   seed = bytes(range(32))
 *   SealedBox(SigningKey(seed).verify_key.to_curve25519_public_key()).encrypt(msg)
 * If our construction drifts from libsodium in any detail (conversion,
 * beforenm, nonce derivation), this vector fails.
 */
const VECTOR = {
  seedB64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  edPubB64: 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=',
  msg: 'Sealed per spec §2 — cafés & 🎈',
  sealedB64:
    'NgWex/C1Cj0dDM/BxO0Y7ifNDQ7NBR0LxxGcaCJyRChc+lP6sWj6O8cut7sCJ5MfjRZvqyDQ0yD6+42yK40LmiKhfGz0ikhlqeAjZAeWFtZje/EwLw==',
};

describe('sealbox (libsodium crypto_box_seal interop)', () => {
  it('opens a sealed box produced by PyNaCl/libsodium', () => {
    expect(openSealed(VECTOR.sealedB64, VECTOR.seedB64)).toBe(VECTOR.msg);
  });

  it('round-trips: seal to an Ed25519 identity, open with its seed', async () => {
    const ident = await generateIdentity();
    const msg = 'knock knock — wie is daar? 🚪';
    const sealed = sealToRecipient(msg, ident.pubkey);
    expect(openSealed(sealed, ident.private_key_b64)).toBe(msg);
    // Sealed boxes are randomized (ephemeral key) — two seals differ.
    expect(sealToRecipient(msg, ident.pubkey)).not.toBe(sealed);
  });

  it('rejects tampering and wrong recipients with null, never throws', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const sealed = sealToRecipient('secret', a.pubkey);
    // wrong key
    expect(openSealed(sealed, b.private_key_b64)).toBeNull();
    // flipped byte in the box body
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    bytes[40] = bytes[40]! ^ 0xff;
    const tampered = btoa(String.fromCharCode(...bytes));
    expect(openSealed(tampered, a.private_key_b64)).toBeNull();
    // garbage in
    expect(openSealed('not base64 !!', a.private_key_b64)).toBeNull();
    expect(openSealed('AAAA', a.private_key_b64)).toBeNull();
  });
});
