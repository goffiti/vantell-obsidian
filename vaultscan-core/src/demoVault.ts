/**
 * Demo vault for mock mode (VITE_MOCK=1) — an in-memory FileProvider with a
 * realistic mix: default-covered capture/person folders, a suspect folder
 * that trips the classification gate, authored notes (one shareable, several
 * private candidates). Lets the whole browser flow run without the File
 * System Access API or network.
 */
import { makeMemoryProvider, type MemoryVault } from './memoryProvider';

const DAY = 86_400_000;

export function makeDemoVault(): MemoryVault {
  const files: Record<string, string> = {
    // capture by default path rules → aggregated as "(capture folders)"
    'Emails/2025/standup-summary.md':
      'From: pm@acme.example\nTo: team@acme.example\nSubject: Standup\nDate: Mon\n\nCaptured mail body.',
    'Emails/2025/renewal-thread.md':
      'From: vendor@saas.example\nTo: me@acme.example\nSubject: Renewal\nDate: Tue\n\nQuoted thread.',
    'Clippings/interesting-article.md': '# Clipped article\n\nSomeone else wrote this.',
    // person notes → "(person folders)"
    'People/jane-doe.md': 'Name: Jane Doe\nEmail: jane@corp.example\nRole: CTO\n\nMet at conf.',
    'People/marc-v.md': 'Name: Marc V.\nCompany: Cronos\nLinkedIn: /in/marcv\n\nIntro pending.',
    // suspect folder — trips the gate (name token 'teams')
    'Teams Export/design-channel.md':
      '[09:12] anna: new tokens pushed\n[09:14] tom: reviewing\n[09:20] anna: merged\n[09:31] tom: ship it\n[09:44] anna: done\n[09:51] tom: thanks',
    'Teams Export/support-channel.md':
      '(10:02 kim: ticket 4521\n(10:05 raj: on it\n(10:11 kim: escalated\n(10:19 raj: patched\n(10:25 kim: verified\n(10:30 raj: closing',
    // authored notes
    'Notes/zero-trust-rollout.md':
      '# Zero-trust rollout\n\n## Why\nOur perimeter model is done for. This note lays out the phased rollout we agreed: identity-aware proxies first, then device posture checks, then the legacy VPN teardown. Each phase has a rollback plan and a measurable exit criterion documented below.\n\n## Phases\n1. Identity-aware proxy pilot\n2. Device posture\n3. VPN teardown\n',
    'Notes/vendor-selection-criteria.md':
      '# Vendor selection criteria\n\nHow we score infrastructure vendors: security posture (30%), exit costs (25%), roadmap fit (25%), support quality (20%). Scores below 60 are a hard no. The scoring sheet lives next to this note and gets a row per candidate; two independent scorers per vendor, discrepancies over 15 points trigger a third review.\n',
    'Notes/published-postmortem.md':
      '---\nvisibility: org\ntopics: [incidents, reliability]\ntitle: March outage postmortem\n---\n# March outage\n\nWhat failed, what we changed. Wrote this for the whole org: the retry storm pattern, the missing circuit breaker, and the alert threshold changes that would have caught it an hour earlier.\n',
    'Notes/private-scratch.md': 'quick thought\n',
    // root file (kept small so the size gate stays quiet in the demo)
    'readme-vault.md': '# My vault\n\nPersonal index note.\n',
  };
  const vault = makeMemoryProvider(files);
  const now = Date.now();
  vault.setMtime('Notes/published-postmortem.md', now - 3 * DAY);
  vault.setMtime('Notes/zero-trust-rollout.md', now - 10 * DAY);
  vault.setMtime('Notes/vendor-selection-criteria.md', now - 40 * DAY);
  return vault;
}
