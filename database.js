const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'benchmark.db');

const db = new Database(DB_PATH);

// Inicializar tablas
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT DEFAULT 'running',
    model_count INTEGER DEFAULT 0,
    source TEXT DEFAULT 'free'
  );

  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    lang TEXT NOT NULL,
    input INTEGER DEFAULT 0,
    output INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(id)
  );

  CREATE INDEX IF NOT EXISTS idx_results_run_id ON results(run_id);
`);

function createRun(source, modelCount) {
  const stmt = db.prepare(`
    INSERT INTO runs (started_at, model_count, source)
    VALUES (datetime('now'), ?, ?)
  `);
  const result = stmt.run(modelCount, source);
  return result.lastInsertRowid;
}

function finishRun(runId, status) {
  const stmt = db.prepare(`
    UPDATE runs 
    SET finished_at = datetime('now'), status = ?
    WHERE id = ?
  `);
  stmt.run(status, runId);
}

function saveResult(runId, data) {
  const stmt = db.prepare(`
    INSERT INTO results (run_id, model, lang, input, output, total, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  return stmt.run(runId, data.model, data.lang, data.input || 0, data.output || 0, data.total || 0, data.error || null);
}

function getAllResults() {
  const runs = db.prepare(`
    SELECT * FROM runs ORDER BY started_at DESC LIMIT 20
  `).all();

  const results = db.prepare(`
    SELECT * FROM results ORDER BY created_at ASC
  `).all();

  return { runs, results };
}

function getResultsByRun(runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  const results = db.prepare('SELECT * FROM results WHERE run_id = ? ORDER BY created_at ASC').all(runId);
  return { run, results };
}

function clearOldRuns() {
  // Mantener solo los últimos 50 runs
  db.prepare(`
    DELETE FROM results WHERE run_id NOT IN (
      SELECT id FROM runs ORDER BY started_at DESC LIMIT 50
    )
  `).run();

  db.prepare(`
    DELETE FROM runs WHERE id NOT IN (
      SELECT id FROM runs ORDER BY started_at DESC LIMIT 50
    )
  `).run();
}

module.exports = {
  db,
  createRun,
  finishRun,
  saveResult,
  getAllResults,
  getResultsByRun,
  clearOldRuns
};