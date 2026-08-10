/**
 * Tests for the "already protected automatically" summary shown on the
 * classify (gate) step.
 */
import { describe, expect, it } from 'vitest';
import { autoProtectedSummary } from '../autoProtected';
import { DEFAULT_VAULT_CONFIG } from '../config';
import type { VaultConfig } from '../types';

function cfg(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    capture_paths: [...DEFAULT_VAULT_CONFIG.capture_paths],
    person_paths: [...DEFAULT_VAULT_CONFIG.person_paths],
    exclude_paths: [...DEFAULT_VAULT_CONFIG.exclude_paths],
    exclude_if_matches: [...DEFAULT_VAULT_CONFIG.exclude_if_matches],
    confirmed_authored: [...DEFAULT_VAULT_CONFIG.confirmed_authored],
    ...overrides,
  };
}

describe('autoProtectedSummary', () => {
  it('buckets covered files per top-level folder, sorted by count desc', () => {
    const rows = autoProtectedSummary(
      [
        'Emails/2025/a.md',
        'Emails/2025/b.md',
        'Emails/c.md',
        'People/jane.md',
        'People/marc.md',
        'Personal/journal.md',
        'Notes/uncovered.md', // matches nothing → no row
      ],
      cfg(),
    );
    expect(rows).toEqual([
      { folder: 'Emails', bucket: 'capture', count: 3 },
      { folder: 'People', bucket: 'person', count: 2 },
      { folder: 'Personal', bucket: 'excluded', count: 1 },
    ]);
  });

  it('matches globs case-insensitively, like the scan pipeline', () => {
    const rows = autoProtectedSummary(
      ['EMAILS2/mail.md', 'peOple/x.md', 'PERSONAL/diary.md'],
      cfg(),
    );
    expect(rows).toEqual([
      { folder: 'EMAILS2', bucket: 'capture', count: 1 },
      { folder: 'PERSONAL', bucket: 'excluded', count: 1 },
      { folder: 'peOple', bucket: 'person', count: 1 },
    ]);
  });

  it('applies capture > person > excluded precedence per file', () => {
    const rows = autoProtectedSummary(
      ['Both/a.md', 'PerExc/b.md'],
      cfg({
        capture_paths: ['Both/**'],
        person_paths: ['Both/**', 'PerExc/**'],
        exclude_paths: ['Both/**', 'PerExc/**'],
      }),
    );
    expect(rows).toEqual([
      { folder: 'Both', bucket: 'capture', count: 1 },
      { folder: 'PerExc', bucket: 'person', count: 1 },
    ]);
  });

  it("groups root files under '(root)' and returns [] when nothing is covered", () => {
    const rows = autoProtectedSummary(
      ['secret-a.md', 'secret-b.md', 'kept.md'],
      cfg({ capture_paths: [], person_paths: [], exclude_paths: ['secret-*'] }),
    );
    expect(rows).toEqual([{ folder: '(root)', bucket: 'excluded', count: 2 }]);
    expect(autoProtectedSummary(['Notes/free.md', 'loose.md'], cfg())).toEqual([]);
  });

  it('a mixed folder yields one row per bucket', () => {
    const rows = autoProtectedSummary(
      ['Mixed/mail.md', 'Mixed/dossier.md', 'Mixed/diary.md', 'Mixed/free.md'],
      cfg({
        capture_paths: ['Mixed/mail*'],
        person_paths: ['Mixed/dossier*'],
        exclude_paths: ['Mixed/diary*'],
      }),
    );
    expect([...rows].sort((a, b) => (a.bucket < b.bucket ? -1 : 1))).toEqual([
      { folder: 'Mixed', bucket: 'capture', count: 1 },
      { folder: 'Mixed', bucket: 'excluded', count: 1 },
      { folder: 'Mixed', bucket: 'person', count: 1 },
    ]);
  });
});
