import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDirectory, db, parseJson, transaction } from './db.js';

export const DEFAULT_COLLECTION = process.env.AI_DEFAULT_COLLECTION || 'rag';
export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
export const DEFAULT_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
export const DEFAULT_TOP_K = 6;
export const DEFAULT_INSTRUCTIONS = `
Sei un assistente RAG per la ricerca semantica in un archivio documentale.
Rispondi in italiano usando il contesto vettoriale, il grafo documentale e la memoria della conversazione.
Non limitarti a restituire il primo risultato: cerca connessioni pertinenti tra luoghi, anni, attori, spettacoli, titoli, documenti e pagine.
Applica una logica di relazione: se la richiesta contiene un anno e un luogo, verifica anche altri spettacoli nello stesso luogo e anno; se contiene un attore, cerca altri spettacoli o documenti collegati allo stesso attore; se contiene uno spettacolo, cerca persone, luoghi, anni e documenti affini. Presenta prima la risposta diretta e poi le connessioni scoperte, distinguendole chiaramente.
Non inventare fatti, citazioni, pagine, attori, luoghi o documenti. Se il contesto non basta, dichiaralo chiaramente.
Il campo message deve essere Markdown leggibile dal frontend. Il campo request deve descrivere in modo sintetico come hai interpretato la domanda e quali filtri o termini hai usato.
Le citations devono riferirsi solo agli elementi presenti nel contesto e includere l'identificativo della fonte.
Struttura la risposta per la leggibilità: usa titoli, elenchi puntati (ul), elenchi numerati (ol) e tabelle Markdown quando ci sono confronti, conteggi o più elementi da organizzare. Usa citazioni brevi e paragrafi separati. Non mostrare token, modello, latenza o dettagli tecnici nel campo message.
Chiudi con una sola domanda di approfondimento soltanto se il contesto contiene una connessione concreta ancora esplorabile, per esempio un altro spettacolo, attore, luogo o documento. Se non c'è altro materiale pertinente, non aggiungere domande artificiali.
`.trim();
const vectorManifestPath = path.join(dataDirectory, 'vector-manifest.json');

export const AI_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description: 'Risposta per l utente in Markdown, senza JSON e senza codice racchiuso da triple backtick.'
    },
    request: {
      type: 'object',
      additionalProperties: false,
      properties: {
        interpretedQuestion: { type: 'string' },
        searchQuery: { type: 'string' },
        filters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            collection: { type: 'string' },
            topK: { type: 'integer' },
            terms: { type: 'array', items: { type: 'string' } }
          },
          required: ['collection', 'topK', 'terms']
        }
      },
      required: ['interpretedQuestion', 'searchQuery', 'filters']
    },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          page: { type: 'string' },
          quote: { type: 'string' }
        },
        required: ['id', 'label', 'page', 'quote']
      }
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    noResults: { type: 'boolean' }
  },
  required: ['message', 'request', 'citations', 'confidence', 'noResults']
};

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function collectionName(value) {
  const name = String(value || DEFAULT_COLLECTION).trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(name)) throw new Error('Nome collection non valido. Usa lettere, numeri, punto, trattino o underscore.');
  return name;
}

function databaseSnapshot(collection, collectionInfo) {
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
  return {
    collection,
    documents: count('documents'),
    pages: count('pages'),
    entities: count('entities'),
    relations: count('relations'),
    vectorizedChunks: Number(collectionInfo.vectorCount || 0),
    embeddingModel: collectionInfo.embeddingModel || DEFAULT_EMBEDDING_MODEL,
    sourceRevision: sourceManifest().revision
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateEmbedding(value, expectedDimensions = null) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(finiteNumber)) return null;
  if (expectedDimensions && value.length !== expectedDimensions) return null;
  return value;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function parseResponseOutput(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) return response.output_text;
  const parts = (response?.output || []).flatMap((item) => item.content || []).filter((item) => item.type === 'output_text' && typeof item.text === 'string');
  return parts.map((part) => part.text).join('\n').trim();
}

function parseStructuredOutput(response) {
  const text = parseResponseOutput(response);
  if (!text) throw new Error('La risposta OpenAI non contiene output testuale.');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('La risposta OpenAI non è un JSON valido.');
  }
}

function usageFromResponse(response) {
  const usage = response?.usage || {};
  return {
    inputTokens: Number(usage.input_tokens || 0),
    outputTokens: Number(usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
    cachedTokens: Number(usage.input_tokens_details?.cached_tokens || 0),
    reasoningTokens: Number(usage.output_tokens_details?.reasoning_tokens || 0)
  };
}

async function openAIRequest(pathname, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TIMEOUT_MS || 90000));
  try {
    const result = await fetch(`https://api.openai.com/v1${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await result.json().catch(() => ({}));
    if (!result.ok) {
      const message = payload?.error?.message || `OpenAI ha restituito HTTP ${result.status}.`;
      const error = new Error(message);
      error.status = result.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createQueryEmbedding(input, model = DEFAULT_EMBEDDING_MODEL) {
  const response = await openAIRequest('/embeddings', { model, input });
  return {
    embedding: response?.data?.[0]?.embedding || [],
    model: response?.model || model,
    inputTokens: Number(response?.usage?.prompt_tokens || 0),
    totalTokens: Number(response?.usage?.total_tokens || 0)
  };
}

function chunkText(value, maxCharacters = 6000, overlap = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.length <= maxCharacters) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + maxCharacters);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

async function createEmbeddingBatch({ jobId, collection, embeddingModel, batch, batchIndex, totalBatches }) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const requestJson = { kind: 'embedding', jobId, collection, batchIndex, totalBatches, inputCount: batch.length, model: embeddingModel };
  db.prepare(`INSERT INTO ai_requests (id, collection_name, question, instructions, model, embedding_model, top_k, status, request_json)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'processing', ?)`).run(
    requestId,
    collection,
    `[vectorize] batch ${batchIndex}/${totalBatches}`,
    'Generazione degli embedding per le pagine del database OCR.',
    embeddingModel,
    embeddingModel,
    JSON.stringify(requestJson)
  );
  try {
    const response = await openAIRequest('/embeddings', { model: embeddingModel, input: batch.map((item) => item.text) });
    const vectors = (response?.data || []).slice().sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    if (vectors.length !== batch.length || vectors.some((item) => !validateEmbedding(item.embedding))) throw new Error('OpenAI ha restituito un numero o una forma di embedding inattesa.');
    const usage = {
      inputTokens: Number(response?.usage?.prompt_tokens || 0),
      outputTokens: 0,
      totalTokens: Number(response?.usage?.total_tokens || response?.usage?.prompt_tokens || 0)
    };
    db.prepare(`UPDATE ai_requests SET status = 'completed', response_id = ?, input_tokens = ?, output_tokens = 0, total_tokens = ?, embedding_input_tokens = ?, latency_ms = ?, response_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      response?.id || null,
      usage.inputTokens,
      usage.totalTokens,
      usage.inputTokens,
      Date.now() - startedAt,
      JSON.stringify({ kind: 'embedding_batch', model: response?.model || embeddingModel, vectorCount: vectors.length, usage }),
      requestId
    );
    return { requestId, vectors, usage, model: response?.model || embeddingModel, latencyMs: Date.now() - startedAt };
  } catch (error) {
    db.prepare(`UPDATE ai_requests SET status = 'error', latency_ms = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(Date.now() - startedAt, error.message || 'Embedding batch non riuscito.', requestId);
    error.requestId = requestId;
    throw error;
  }
}

export async function vectorizeDatabase({ jobId, collection, embeddingModel = DEFAULT_EMBEDDING_MODEL, pageLimit = null, batchSize = 64, force = false, onProgress = () => {} }) {
  if (!hasOpenAIKey()) throw new Error('OPENAI_API_KEY è necessaria per vettorializzare il database.');
  const name = collectionName(collection);
  const sourceAtStart = sourceManifest();
  db.prepare(`INSERT INTO ai_collections (name, embedding_model, vector_count) VALUES (?, ?, 0)
    ON CONFLICT(name) DO UPDATE SET embedding_model = excluded.embedding_model, updated_at = CURRENT_TIMESTAMP`).run(name, embeddingModel);
  updateVectorStoreManifest({ collection: name, embeddingModel, vectorCount: vectorCollectionStats(name).vectorCount, status: 'processing', jobId });
  const safeBatchSize = Math.min(Math.max(Number(batchSize) || 64, 1), 100);
  const safePageLimit = pageLimit == null || pageLimit === '' ? null : Math.min(Math.max(Number(pageLimit) || 1, 1), 1000000);
  const pageSql = `SELECT p.id AS pageId, p.page_number AS pageNumber, p.text, d.id AS documentId, d.file_name AS fileName, d.title, d.source_key AS sourceKey
    FROM pages p JOIN documents d ON d.id = p.document_id
    WHERE length(trim(p.text)) > 0 ORDER BY p.id${safePageLimit ? ` LIMIT ${safePageLimit}` : ''}`;
  const pages = db.prepare(pageSql).all();
  const existingBefore = force ? new Map() : new Map(db.prepare('SELECT external_id AS id, text FROM ai_vectors WHERE collection_name = ?').all(name).map((row) => [row.id, row.text]));
  const chunks = [];
  let totalCandidateChunks = 0;
  const expectedIds = new Set();
  for (const page of pages) {
    const pageChunks = chunkText(page.text);
    totalCandidateChunks += pageChunks.length;
    pageChunks.forEach((text, chunkIndex) => {
      const id = `page:${page.pageId}:chunk:${chunkIndex}`;
      expectedIds.add(id);
      if (!force && existingBefore.get(id) === text) return;
      chunks.push({
        id,
        text,
        metadata: { pageId: page.pageId, pageNumber: page.pageNumber, documentId: page.documentId, fileName: page.fileName, title: page.title, sourceKey: page.sourceKey, chunkIndex }
      });
    });
  }
  if (safePageLimit == null) {
    const staleIds = db.prepare(`SELECT external_id AS id FROM ai_vectors WHERE collection_name = ? AND external_id LIKE 'page:%'`).all(name).map((row) => row.id).filter((id) => !expectedIds.has(id));
    if (staleIds.length) db.prepare(`DELETE FROM ai_vectors WHERE collection_name = ? AND external_id IN (${staleIds.map(() => '?').join(',')})`).run(name, ...staleIds);
  }
  const existing = force ? new Map() : new Map(db.prepare('SELECT external_id AS id, text FROM ai_vectors WHERE collection_name = ?').all(name).map((row) => [row.id, row.text]));
  const totalBatches = Math.ceil(chunks.length / safeBatchSize);
  let completedChunks = 0;
  let inputTokens = 0;
  let lastModel = embeddingModel;
  onProgress({ totalPages: pages.length, completedChunks: 0, totalChunks: chunks.length, inputTokens: 0, vectorCount: vectorCollectionStats(name).vectorCount });
  for (let offset = 0; offset < chunks.length; offset += safeBatchSize) {
    const batch = chunks.slice(offset, offset + safeBatchSize);
    const batchIndex = Math.floor(offset / safeBatchSize) + 1;
    const result = await createEmbeddingBatch({ jobId, collection: name, embeddingModel, batch, batchIndex, totalBatches });
    upsertVectorDocuments({ collection: name, embeddingModel: result.model, documents: batch.map((item, index) => ({ ...item, embedding: result.vectors[index].embedding })) });
    completedChunks += batch.length;
    inputTokens += result.usage.inputTokens;
    lastModel = result.model;
    onProgress({ totalPages: pages.length, completedChunks, totalChunks: chunks.length, inputTokens, vectorCount: vectorCollectionStats(name).vectorCount });
  }
  const vectorCount = vectorCollectionStats(name).vectorCount;
  const sourceAtEnd = sourceManifest();
  const sourceChangedDuringJob = sourceAtEnd.revision !== sourceAtStart.revision;
  const manifestStatus = sourceChangedDuringJob ? 'stale' : 'completed';
  updateVectorStoreManifest({ collection: name, embeddingModel: lastModel, vectorCount, status: manifestStatus, jobId });
  return { collection: name, embeddingModel: lastModel, pages: pages.length, chunks: chunks.length, skippedChunks: totalCandidateChunks - chunks.length, batches: totalBatches, inputTokens, vectorCount, sourceChangedDuringJob, status: manifestStatus };
}

export function upsertVectorDocuments({ collection, documents, embeddingModel = DEFAULT_EMBEDDING_MODEL }) {
  const name = collectionName(collection);
  if (!Array.isArray(documents) || documents.length === 0) throw new Error('documents deve essere un array non vuoto.');
  const normalized = documents.map((document, index) => {
    const id = String(document?.id ?? document?.externalId ?? `${index + 1}`).trim();
    const text = String(document?.text ?? document?.content ?? '').trim();
    const embedding = validateEmbedding(document?.embedding ?? document?.vector);
    if (!id || !text || !embedding) throw new Error(`Vettore non valido alla posizione ${index}: servono id, text e embedding numerico.`);
    return { id, text, embedding, metadata: document?.metadata && typeof document.metadata === 'object' ? document.metadata : {} };
  });
  const dimensions = normalized[0].embedding.length;
  if (normalized.some((document) => document.embedding.length !== dimensions)) throw new Error('Tutti gli embedding della stessa collection devono avere la stessa dimensione.');

  transaction(() => {
    db.prepare(`INSERT INTO ai_collections (name, embedding_model, dimensions, vector_count)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(name) DO UPDATE SET embedding_model = excluded.embedding_model, dimensions = excluded.dimensions, updated_at = CURRENT_TIMESTAMP`).run(name, embeddingModel, dimensions);
    const insert = db.prepare(`INSERT INTO ai_vectors (collection_name, external_id, text, embedding_json, metadata_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection_name, external_id) DO UPDATE SET text = excluded.text, embedding_json = excluded.embedding_json, metadata_json = excluded.metadata_json, updated_at = CURRENT_TIMESTAMP`);
    for (const document of normalized) insert.run(name, document.id, document.text, JSON.stringify(document.embedding), JSON.stringify(document.metadata));
    db.prepare('UPDATE ai_collections SET vector_count = (SELECT COUNT(*) FROM ai_vectors WHERE collection_name = ?), updated_at = CURRENT_TIMESTAMP WHERE name = ?').run(name, name);
  });
  const stats = db.prepare('SELECT name, embedding_model AS embeddingModel, dimensions, vector_count AS vectorCount, created_at AS createdAt, updated_at AS updatedAt FROM ai_collections WHERE name = ?').get(name);
  return { collection: stats.name, embeddingModel: stats.embeddingModel, dimensions: stats.dimensions, upserted: normalized.length, vectorCount: stats.vectorCount, createdAt: stats.createdAt, updatedAt: stats.updatedAt };
}

export function vectorCollectionStats(collection) {
  const name = collectionName(collection);
  const stats = db.prepare('SELECT name, embedding_model AS embeddingModel, dimensions, vector_count AS vectorCount, created_at AS createdAt, updated_at AS updatedAt FROM ai_collections WHERE name = ?').get(name);
  return stats || { name, embeddingModel: null, dimensions: null, vectorCount: 0 };
}

export function sourceManifest() {
  return db.prepare('SELECT revision, metadata_updated_at AS metadataUpdatedAt FROM source_manifest WHERE id = 1').get() || { revision: 0, metadataUpdatedAt: null };
}

export function vectorStoreStatus(collection) {
  const name = collectionName(collection);
  const source = sourceManifest();
  const stats = vectorCollectionStats(name);
  const manifest = db.prepare(`SELECT collection_name AS collection, source_revision AS sourceRevision, source_metadata_updated_at AS sourceMetadataUpdatedAt, vectorized_at AS vectorizedAt, embedding_model AS embeddingModel, vector_count AS vectorCount, status, last_job_id AS lastJobId FROM ai_manifests WHERE collection_name = ?`).get(name) || null;
  const activeJob = db.prepare(`SELECT id AS jobId, status, total_pages AS totalPages, total_chunks AS totalChunks, completed_chunks AS completedChunks, error FROM ai_vectorization_jobs WHERE collection_name = ? AND status IN ('waiting', 'processing') ORDER BY created_at DESC LIMIT 1`).get(name) || null;
  const upToDate = Boolean(manifest && manifest.status === 'completed' && manifest.sourceRevision === source.revision && manifest.vectorCount === stats.vectorCount);
  return { collection: name, source, stats, manifest, activeJob, upToDate, needsVectorization: !upToDate && !activeJob };
}

export function writeVectorManifest() {
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: sourceManifest(),
    collections: db.prepare(`SELECT collection_name AS collection, source_revision AS sourceRevision, source_metadata_updated_at AS sourceMetadataUpdatedAt, vectorized_at AS vectorizedAt, embedding_model AS embeddingModel, vector_count AS vectorCount, status, last_job_id AS lastJobId FROM ai_manifests ORDER BY collection_name`).all()
  };
  fs.writeFileSync(vectorManifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export function updateVectorStoreManifest({ collection, embeddingModel, vectorCount, status, jobId }) {
  const source = sourceManifest();
  db.prepare(`INSERT INTO ai_manifests (collection_name, source_revision, source_metadata_updated_at, vectorized_at, embedding_model, vector_count, status, last_job_id)
    VALUES (?, ?, ?, CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END, ?, ?, ?, ?)
    ON CONFLICT(collection_name) DO UPDATE SET source_revision = excluded.source_revision, source_metadata_updated_at = excluded.source_metadata_updated_at, vectorized_at = CASE WHEN excluded.status = 'completed' THEN CURRENT_TIMESTAMP ELSE ai_manifests.vectorized_at END, embedding_model = excluded.embedding_model, vector_count = excluded.vector_count, status = excluded.status, last_job_id = excluded.last_job_id`).run(collection, source.revision, source.metadataUpdatedAt, status, embeddingModel, vectorCount, status, jobId || null);
  return writeVectorManifest();
}

export function searchVectorDocuments(collection, queryEmbedding, topK = DEFAULT_TOP_K) {
  const name = collectionName(collection);
  const rows = db.prepare('SELECT external_id AS id, text, embedding_json AS embeddingJson, metadata_json AS metadataJson FROM ai_vectors WHERE collection_name = ?').all(name);
  return rows.map((row) => {
    const embedding = parseJson(row.embeddingJson, []);
    const score = cosineSimilarity(queryEmbedding, embedding);
    if (score == null) return null;
    return { id: row.id, text: row.text, metadata: parseJson(row.metadataJson, {}), score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(Number(topK) || DEFAULT_TOP_K, 1), 20));
}

function contextFor(retrieval) {
  if (!retrieval.length) return 'Nessun elemento vettoriale rilevante è stato recuperato.';
  return retrieval.map((item, index) => {
    const metadata = Object.entries(item.metadata || {}).map(([key, value]) => `${key}=${String(value)}`).join(', ');
    return `[SOURCE ${index + 1}] id=${item.id}; score=${item.score.toFixed(4)}; ${metadata}\n${item.text.slice(0, 3200)}`;
  }).join('\n\n');
}

function connectionContext(retrieval) {
  const documentIds = [...new Set(retrieval.map((item) => Number(item.metadata?.documentId)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!documentIds.length) return 'Nessuna connessione documentale aggiuntiva disponibile.';
  const placeholders = documentIds.map(() => '?').join(',');
  const sourceDocuments = db.prepare(`SELECT id, file_name AS fileName, title FROM documents WHERE id IN (${placeholders})`).all(...documentIds);
  const entities = db.prepare(`
    SELECT de.document_id AS documentId, e.entity_type AS type, e.value, de.occurrences
    FROM document_entities de JOIN entities e ON e.id = de.entity_id
    WHERE de.document_id IN (${placeholders})
    ORDER BY de.occurrences DESC, e.entity_type, e.value
    LIMIT 100
  `).all(...documentIds);
  const relations = db.prepare(`
    SELECT r.score, da.file_name AS documentA, db.file_name AS documentB, r.shared_entities_json AS sharedEntitiesJson
    FROM relations r
    JOIN documents da ON da.id = r.document_a_id
    JOIN documents db ON db.id = r.document_b_id
    WHERE r.document_a_id IN (${placeholders}) OR r.document_b_id IN (${placeholders})
    ORDER BY r.score DESC
    LIMIT 60
  `).all(...documentIds, ...documentIds);
  const lines = ['Documenti agganciati ai risultati semantici:'];
  sourceDocuments.forEach((document) => lines.push(`- SOURCE_DOCUMENT id=${document.id}; file=${document.fileName}; title=${document.title || ''}`));
  if (entities.length) {
    lines.push('Entità condivise o estratte:');
    entities.forEach((entity) => lines.push(`- documentId=${entity.documentId}; tipo=${entity.type}; valore=${entity.value}; occorrenze=${entity.occurrences}`));
  }
  if (relations.length) {
    lines.push('Relazioni tra documenti:');
    relations.forEach((relation) => {
      const shared = parseJson(relation.sharedEntitiesJson, []).map((item) => typeof item === 'string' ? item : item.value || item.name || JSON.stringify(item)).join(', ');
      lines.push(`- ${relation.documentA} ↔ ${relation.documentB}; score=${relation.score}; entità condivise=${shared || 'non specificate'}`);
    });
  }
  return lines.join('\n');
}

function validateStructured(value, collection, topK, retrieval = []) {
  if (!value || typeof value.message !== 'string' || !value.request || !Array.isArray(value.citations) || typeof value.noResults !== 'boolean') throw new Error('Output strutturato incompleto.');
  const availableIds = new Set(retrieval.map((item) => String(item.id)));
  return {
    message: value.message.trim(),
    request: {
      interpretedQuestion: String(value.request.interpretedQuestion || ''),
      searchQuery: String(value.request.searchQuery || ''),
      filters: {
        collection: String(value.request.filters?.collection || collection),
        topK: Number(value.request.filters?.topK || topK),
        terms: Array.isArray(value.request.filters?.terms) ? value.request.filters.terms.map(String) : []
      }
    },
    citations: value.citations.map((citation) => ({ id: String(citation.id || ''), label: String(citation.label || ''), page: String(citation.page || ''), quote: String(citation.quote || '') })).filter((citation) => availableIds.has(citation.id)),
    confidence: ['high', 'medium', 'low'].includes(value.confidence) ? value.confidence : 'low',
    noResults: Boolean(value.noResults || retrieval.length === 0)
  };
}

export async function runAIQuery({ sessionId, question, instructions = DEFAULT_INSTRUCTIONS, collection = DEFAULT_COLLECTION, topK = DEFAULT_TOP_K, model = DEFAULT_MODEL, embeddingModel = DEFAULT_EMBEDDING_MODEL, queryEmbedding = null, history = [] }) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const name = collectionName(collection);
  const normalizedQuestion = String(question || '').trim();
  const normalizedInstructions = String(instructions || DEFAULT_INSTRUCTIONS).trim() || DEFAULT_INSTRUCTIONS;
  const normalizedTopK = Math.min(Math.max(Number(topK) || DEFAULT_TOP_K, 1), 20);
  const collectionInfo = vectorCollectionStats(name);
  const snapshot = databaseSnapshot(name, collectionInfo);
  const selectedEmbeddingModel = collectionInfo.embeddingModel || embeddingModel;
  const requestBody = { sessionId: sessionId || null, collection: name, question: normalizedQuestion, instructions: normalizedInstructions, model, embeddingModel: selectedEmbeddingModel, topK: normalizedTopK, hasQueryEmbedding: Boolean(queryEmbedding), provider: 'openai', databaseSnapshot: snapshot };
  db.prepare(`INSERT INTO ai_requests (id, session_id, collection_name, question, instructions, model, embedding_model, top_k, status, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)`).run(requestId, sessionId || null, name, normalizedQuestion, normalizedInstructions, model, selectedEmbeddingModel, normalizedTopK, JSON.stringify(requestBody));

  let embeddingInputTokens = 0;
  try {
    if (!hasOpenAIKey()) {
      const error = new Error('OpenAI non è configurata nel backend. Imposta OPENAI_API_KEY e riavvia il server.');
      error.status = 503;
      throw error;
    }
    let retrieval = [];
    if (collectionInfo.vectorCount > 0) {
      let embedding = validateEmbedding(queryEmbedding, collectionInfo.dimensions);
      if (!embedding) {
        const embeddingResponse = await createQueryEmbedding(normalizedQuestion, selectedEmbeddingModel);
        embedding = validateEmbedding(embeddingResponse.embedding, collectionInfo.dimensions);
        embeddingInputTokens = embeddingResponse.inputTokens;
      }
      if (embedding) retrieval = searchVectorDocuments(name, embedding, normalizedTopK);
    }

    const graphContext = connectionContext(retrieval);
    const historyInput = history.filter((message) => ['user', 'assistant'].includes(message.role) && message.content).slice(-8).map((message) => ({ role: message.role, content: String(message.content).slice(0, 4000) }));
    const prompt = `Domanda dell'utente:\n${normalizedQuestion}\n\nRiepilogo globale del database vettorializzato "${name}":\n- documenti totali: ${snapshot.documents}\n- pagine totali: ${snapshot.pages}\n- entità totali: ${snapshot.entities}\n- relazioni totali: ${snapshot.relations}\n- chunk vettorializzati: ${snapshot.vectorizedChunks}\n\nUsa questi valori globali per rispondere alle domande quantitative. Non confondere il numero di fonti recuperate con il totale del database. La ricerca semantica ha interrogato l'intera collection vettoriale.\n\nContesto semantico più rilevante:\n${contextFor(retrieval)}\n\nContesto del grafo e delle connessioni:\n${graphContext}\n\nProduci esclusivamente l'oggetto conforme allo schema JSON. Usa Markdown solo dentro message.`;
    const openAIResponse = await openAIRequest('/responses', {
      model,
      instructions: `${normalizedInstructions}\n\nLa risposta deve essere un JSON conforme allo schema fornito. Non aggiungere proprietà extra.`,
      input: [...historyInput, { role: 'user', content: prompt }],
      text: { format: { type: 'json_schema', name: 'rag_response', strict: true, schema: AI_RESPONSE_SCHEMA } },
      max_output_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 1200),
      store: false
    });
    const structured = validateStructured(parseStructuredOutput(openAIResponse), name, normalizedTopK, retrieval);
    const usage = usageFromResponse(openAIResponse);
    const telemetry = { provider: 'openai', responseId: openAIResponse.id || null, model: openAIResponse.model || model, embeddingModel: selectedEmbeddingModel, usage: { ...usage, embeddingInputTokens }, latencyMs: Date.now() - startedAt };

    const responseJson = { structured, retrieval: retrieval.map(({ embedding, ...item }) => item), databaseSnapshot: snapshot, telemetry };
    db.prepare(`UPDATE ai_requests SET status = 'completed', response_id = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, embedding_input_tokens = ?, latency_ms = ?, response_json = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(telemetry.responseId, telemetry.usage.inputTokens, telemetry.usage.outputTokens, telemetry.usage.totalTokens, embeddingInputTokens, telemetry.latencyMs, JSON.stringify(responseJson), requestId);
    return { requestId, structured, retrieval, databaseSnapshot: snapshot, telemetry };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    db.prepare(`UPDATE ai_requests SET status = 'error', embedding_input_tokens = ?, latency_ms = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(embeddingInputTokens, latencyMs, error.message || 'Richiesta AI non riuscita.', requestId);
    error.requestId = requestId;
    throw error;
  }
}

export function aiRequestRows({ limit = 50, sessionId = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.prepare(`SELECT id, session_id AS sessionId, collection_name AS collection, question, model, embedding_model AS embeddingModel, top_k AS topK, status, response_id AS responseId, input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens, embedding_input_tokens AS embeddingInputTokens, latency_ms AS latencyMs, error, created_at AS createdAt, completed_at AS completedAt FROM ai_requests WHERE (? IS NULL OR session_id = ?) ORDER BY created_at DESC LIMIT ${safeLimit}`).all(sessionId, sessionId);
}

export function aiRequestById(id) {
  const row = db.prepare(`SELECT id, session_id AS sessionId, collection_name AS collection, question, instructions, model, embedding_model AS embeddingModel, top_k AS topK, status, response_id AS responseId, input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens, embedding_input_tokens AS embeddingInputTokens, latency_ms AS latencyMs, error, request_json AS requestJson, response_json AS responseJson, created_at AS createdAt, completed_at AS completedAt FROM ai_requests WHERE id = ?`).get(String(id));
  if (!row) return null;
  return { ...row, request: parseJson(row.requestJson, {}), response: parseJson(row.responseJson, {}) };
}
