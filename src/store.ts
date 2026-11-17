import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL, summary TEXT); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, body TEXT NOT NULL)');
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(column => column.name === 'summary')) this.db.exec('ALTER TABLE runs ADD COLUMN summary TEXT');
    for (const row of this.db.prepare('SELECT id,body FROM runs WHERE summary IS NULL').all()) this.save(String(row.id), JSON.parse(String(row.body)));
  }
  save(id: string, run: { id: string; scenario: string; createdAt: string; state: string; stage: number; decision: { status: string } | null }) {
    const summary = { id: run.id, scenario: run.scenario, createdAt: run.createdAt, state: run.state, stage: run.stage, status: run.decision?.status ?? null };
    this.db.prepare('INSERT INTO runs (id,body,summary) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,summary=excluded.summary').run(id, JSON.stringify(run), JSON.stringify(summary));
  }
  history() { return this.db.prepare('SELECT summary FROM runs ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.summary))); }
  get(id: string) { const row = this.db.prepare('SELECT body FROM runs WHERE id=?').get(id); return row ? JSON.parse(String(row.body)) : null; }
  metadata(key: string) { const row = this.db.prepare('SELECT body FROM metadata WHERE key=?').get(key); return row ? JSON.parse(String(row.body)) : null; }
  setMetadata(key: string, value: unknown) { this.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value)); }
  close() { this.db.close(); }
}
