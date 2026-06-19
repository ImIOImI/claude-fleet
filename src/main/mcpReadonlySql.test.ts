import { describe, it, expect } from 'vitest';
import { isReadOnlySql } from './mcpReadonlySql';

describe('isReadOnlySql', () => {
  it('allows SELECT / WITH / EXPLAIN / VALUES', () => {
    expect(isReadOnlySql('SELECT * FROM sessions').ok).toBe(true);
    expect(isReadOnlySql('  select 1  ').ok).toBe(true);
    expect(isReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x').ok).toBe(true);
    expect(isReadOnlySql('EXPLAIN QUERY PLAN SELECT * FROM events').ok).toBe(true);
    expect(isReadOnlySql('VALUES (1),(2)').ok).toBe(true);
    expect(isReadOnlySql('SELECT 1;').ok).toBe(true); // single trailing ;
  });

  it('allows read-form PRAGMA but not assignment', () => {
    expect(isReadOnlySql('PRAGMA table_info(events)').ok).toBe(true);
    expect(isReadOnlySql('PRAGMA user_version = 5').ok).toBe(false);
  });

  it('rejects writes', () => {
    for (const sql of [
      'DELETE FROM events',
      'INSERT INTO sessions VALUES (1)',
      'UPDATE sessions SET ai_title = "x"',
      'DROP TABLE events',
      'CREATE TABLE t (a)',
      'ALTER TABLE events ADD COLUMN x'
    ]) {
      expect(isReadOnlySql(sql).ok, sql).toBe(false);
    }
  });

  it('rejects multi-statement injection', () => {
    expect(isReadOnlySql('SELECT 1; DROP TABLE events').ok).toBe(false);
    expect(isReadOnlySql('SELECT 1; SELECT 2').ok).toBe(false);
  });

  it('is not fooled by a leading comment', () => {
    expect(isReadOnlySql('/* hi */ DELETE FROM events').ok).toBe(false);
    expect(isReadOnlySql('-- c\nSELECT 1').ok).toBe(true);
  });

  it('rejects empty / non-string', () => {
    expect(isReadOnlySql('   ').ok).toBe(false);
    expect(isReadOnlySql('' as string).ok).toBe(false);
    expect(isReadOnlySql(undefined as unknown as string).ok).toBe(false);
  });
});
