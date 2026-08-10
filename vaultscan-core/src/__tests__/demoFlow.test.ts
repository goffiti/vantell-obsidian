/**
 * End-to-end: the exact sequence BrowserConnect drives, on the mock-mode
 * demo vault — gate fires, owner classifies, rescan, share a candidate,
 * payloads stay free of locked names.
 */
import { describe, expect, it } from 'vitest';
import { gateCheck, scan } from '../classify';
import { loadVaultConfig, saveVaultConfig } from '../config';
import { makeDemoVault } from '../demoVault';
import { listCandidates, markNote } from '../mark';
import { generateIdentity } from '../identity';
import { buildManifest, buildVaultReport, signedManifest } from '../publishPayloads';

describe('demo vault → full wizard sequence', () => {
  it('runs gate → classify → rescan → share → publish payloads', async () => {
    const fp = makeDemoVault();
    const { cfg, created } = await loadVaultConfig(fp);
    expect(created).toBe(true); // wrote .vantell.yml into the (in-memory) vault

    // Gate fires on the Teams Export folder
    const suspects = await gateCheck(fp, cfg);
    expect(suspects.map((s) => s.folder)).toContain('Teams Export');

    // Owner: captured material → categorical lock, saved to .vantell.yml
    cfg.capture_paths.push('Teams Export/**');
    await saveVaultConfig(fp, cfg);
    const { cfg: reloaded } = await loadVaultConfig(fp);
    expect(reloaded.capture_paths).toContain('Teams Export/**');
    expect(await gateCheck(fp, reloaded)).toEqual([]);

    // Scan: one pre-shared note, locked rows aggregated
    const first = await scan(fp, reloaded);
    expect(first.transmitSafe.stats.shareable_notes).toBe(1);
    const wire1 = JSON.stringify(first.transmitSafe);
    for (const name of ['Teams Export', 'Emails', 'People', 'jane', 'marc']) {
      expect(wire1).not.toContain(name);
    }

    // Share step: mark a candidate, count rises
    const cands = await listCandidates(fp, reloaded);
    expect(cands.length).toBeGreaterThanOrEqual(2);
    const pick = cands[0]!;
    const marked = markNote(pick.rel, await fp.read(pick.rel), reloaded, {
      visibility: 'org',
      topics: ['security'],
    });
    expect(marked.ok).toBe(true);
    if (!marked.ok) return;
    await fp.write(pick.rel, marked.content);
    const second = await scan(fp, reloaded);
    expect(second.transmitSafe.stats.shareable_notes).toBe(2);
    expect(second.transmitSafe.topics.map((t) => t.label)).toContain('security');

    // Publish payloads: signed manifest + report, still no locked names
    const ident = await generateIdentity();
    const manifest = await signedManifest(
      buildManifest(second.transmitSafe, {
        did: 'did:knock:acme:demo',
        pubkey: ident.pubkey,
        displayName: 'Demo',
      }),
      ident.private_key_b64,
    );
    const report = buildVaultReport(second.transmitSafe);
    const wire2 = JSON.stringify(manifest) + JSON.stringify(report);
    for (const name of ['Teams Export', 'Emails', 'People', 'jane', 'marc']) {
      expect(wire2).not.toContain(name);
    }
    expect(typeof manifest.sig).toBe('string');
    expect(report.stats.total_notes).toBe(second.transmitSafe.stats.total_notes);
  });
});
