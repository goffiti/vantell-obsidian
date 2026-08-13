/**
 * @vantell/vaultscan-core — public surface.
 *
 * The scanner, classification rules, payload builders, and signing
 * primitives shared by every Vantell client (today: the Obsidian plugin;
 * parity twin: skill/vantell-connect's Python scripts).
 *
 * Privacy invariant, structural: `ScanResult.transmitSafe` is the ONLY
 * input `publishPayloads` accepts — real locked/private folder names live
 * in `localOnly` and have no path into any payload.
 */
export * from './types';
export * from './glob';
export * from './frontmatter';
export * from './heuristics';
export * from './config';
export * from './classify';
export * from './mark';
export * from './autoProtected';
export * from './identity';
export * from './sealbox';
export * from './publishPayloads';
export * from './memoryProvider';
export * from './demoVault';
