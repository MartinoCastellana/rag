import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDirectory = path.resolve(__dirname, '../data');
fs.mkdirSync(dataDirectory, { recursive: true });

const databasePath = process.env.DATABASE_PATH || path.join(dataDirectory, 'rag.db');
export const db = new DatabaseSync(databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

export function transaction(callback) {
  db.exec('BEGIN');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_key TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      absolute_path TEXT,
      title TEXT,
      mime_type TEXT,
      checksum TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page_number INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      extracted_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(document_id, page_number)
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      value TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      UNIQUE(entity_type, normalized_value)
    );

    CREATE TABLE IF NOT EXISTS page_entities (
      page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      raw_value TEXT NOT NULL,
      confidence REAL,
      source TEXT NOT NULL DEFAULT 'ocr-json',
      PRIMARY KEY(page_id, entity_id, raw_value)
    );

    CREATE TABLE IF NOT EXISTS document_entities (
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      occurrences INTEGER NOT NULL DEFAULT 1,
      page_numbers_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(document_id, entity_id)
    );

    CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_a_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      document_b_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      shared_entities_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(document_a_id, document_b_id),
      CHECK(document_a_id < document_b_id)
    );

    CREATE TABLE IF NOT EXISTS extraction_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      staged_path TEXT NOT NULL,
      absolute_path TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      error TEXT,
      json_file_name TEXT,
      page_count INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Nuova conversazione',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_collections (
      name TEXT PRIMARY KEY,
      embedding_model TEXT,
      dimensions INTEGER,
      vector_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS source_manifest (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      revision INTEGER NOT NULL DEFAULT 0,
      metadata_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO source_manifest (id, revision) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS ai_manifests (
      collection_name TEXT PRIMARY KEY REFERENCES ai_collections(name) ON DELETE CASCADE,
      source_revision INTEGER NOT NULL DEFAULT 0,
      source_metadata_updated_at TEXT,
      vectorized_at TEXT,
      embedding_model TEXT,
      vector_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'stale',
      last_job_id TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_name TEXT NOT NULL REFERENCES ai_collections(name) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(collection_name, external_id)
    );

    CREATE TABLE IF NOT EXISTS ai_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
      collection_name TEXT,
      question TEXT NOT NULL,
      instructions TEXT NOT NULL,
      model TEXT NOT NULL,
      embedding_model TEXT,
      top_k INTEGER NOT NULL DEFAULT 6,
      status TEXT NOT NULL DEFAULT 'processing',
      response_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      embedding_input_tokens INTEGER,
      latency_ms INTEGER,
      error TEXT,
      request_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_vectorization_jobs (
      id TEXT PRIMARY KEY,
      collection_name TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      force_rebuild INTEGER NOT NULL DEFAULT 0,
      page_limit INTEGER,
      batch_size INTEGER NOT NULL DEFAULT 64,
      total_pages INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      completed_chunks INTEGER NOT NULL DEFAULT 0,
      vector_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pages_document ON pages(document_id);
    CREATE INDEX IF NOT EXISTS idx_document_entities_entity ON document_entities(entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_a ON relations(document_a_id);
    CREATE INDEX IF NOT EXISTS idx_relations_b ON relations(document_b_id);
    CREATE INDEX IF NOT EXISTS idx_relations_score ON relations(score DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_extraction_jobs_batch ON extraction_jobs(batch_id, id);
    CREATE INDEX IF NOT EXISTS idx_extraction_jobs_status ON extraction_jobs(status, id);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_ai_vectors_collection ON ai_vectors(collection_name, id);
    CREATE INDEX IF NOT EXISTS idx_ai_requests_session ON ai_requests(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_requests_status ON ai_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_vectorization_jobs_status ON ai_vectorization_jobs(status, created_at);

    CREATE TRIGGER IF NOT EXISTS trg_source_manifest_documents_insert AFTER INSERT ON documents BEGIN UPDATE source_manifest SET revision = revision + 1, metadata_updated_at = CURRENT_TIMESTAMP WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS trg_source_manifest_documents_update AFTER UPDATE ON documents BEGIN UPDATE source_manifest SET revision = revision + 1, metadata_updated_at = CURRENT_TIMESTAMP WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS trg_source_manifest_documents_delete AFTER DELETE ON documents BEGIN UPDATE source_manifest SET revision = revision + 1, metadata_updated_at = CURRENT_TIMESTAMP WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS trg_source_manifest_pages_insert AFTER INSERT ON pages BEGIN UPDATE source_manifest SET revision = revision + 1, metadata_updated_at = CURRENT_TIMESTAMP WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS trg_source_manifest_pages_update AFTER UPDATE ON pages BEGIN UPDATE source_manifest SET revision = revision + 1, metadata_updated_at = CURRENT_TIMESTAMP WHERE id = 1; END;
    CREATE TRIGGER IF NOT EXISTS trg_source_manifest_pages_delete AFTER DELETE ON pages BEGIN UPDATE source_manifest SET revision = revision + 1, metadata_updated_at = CURRENT_TIMESTAMP WHERE id = 1; END;
  `);

  // Migrazione per i database creati prima dell'introduzione della path assoluta.
  const documentColumns = db.prepare('PRAGMA table_info(documents)').all().map((column) => column.name);
  if (!documentColumns.includes('absolute_path')) db.exec('ALTER TABLE documents ADD COLUMN absolute_path TEXT');
}

export function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeValue(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeType(value) {
  const type = normalizeValue(value).replace(/[ -]+/g, '_');
  const aliases = {
    luogo: 'location',
    place: 'location',
    localita: 'location',
    anno: 'year',
    parola_chiave: 'keyword',
    keywords: 'keyword',
    persone: 'person',
    persona: 'person',
    organizzazione: 'organization'
  };
  return aliases[type] || type || 'keyword';
}

export function serialize(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}
