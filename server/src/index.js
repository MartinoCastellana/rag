import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db, initializeDatabase, normalizeValue, parseJson, transaction } from './db.js';
import { rebuildRelations, textTerms } from './ingest.js';
import { checksumFile, extractAndPersist, extractionsDirectory, uploadsDirectory } from './extractor.js';
import { ExtractionQueue } from './extractionQueue.js';
import { aiRequestById, aiRequestRows, DEFAULT_COLLECTION, DEFAULT_EMBEDDING_MODEL, DEFAULT_INSTRUCTIONS, DEFAULT_MODEL, runAIQuery, updateVectorStoreManifest, upsertVectorDocuments, vectorCollectionStats, vectorStoreStatus, vectorizeDatabase, writeVectorManifest } from './ai.js';

initializeDatabase();
writeVectorManifest();
const app = express();
const port = Number(process.env.PORT || 4000);
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDirectory,
    filename: (_request, file, callback) => callback(null, `${crypto.randomUUID()}-${path.basename(file.originalname)}`)
  })
});

app.use(cors());
app.use(express.json({ limit: Infinity }));

const DEMO_DATABASE_USER = 'admin';
const DEMO_DATABASE_PASSWORD = 'rag-demo';
const DEMO_DATABASE_TOKEN = 'rag-demo-access';
const extractionQueue = new ExtractionQueue();

function queueJob(jobId) {
  return extractionQueue.enqueue(async () => {
    const job = db.prepare('SELECT * FROM extraction_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    db.prepare(`UPDATE extraction_jobs SET status = 'processing', started_at = CURRENT_TIMESTAMP, error = NULL WHERE id = ?`).run(jobId);
    try {
      const fileChecksum = await checksumFile(job.staged_path);
      const existing = db.prepare('SELECT id, checksum FROM documents WHERE source_key = ?').get(job.source_key);
      if (existing?.checksum && existing.checksum === fileChecksum) {
        const jsonEntry = (await fsp.readdir(extractionsDirectory)).find((name) => name.startsWith(`${fileChecksum.slice(0, 12)}-`) && name.endsWith('.json'));
        await fsp.unlink(job.staged_path).catch(() => {});
        db.prepare(`UPDATE extraction_jobs SET status = 'completed', json_file_name = ?, page_count = (SELECT COUNT(*) FROM pages WHERE document_id = ?), completed_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(jsonEntry || null, existing.id, jobId);
        return;
      }
      const result = await extractAndPersist({
        inputPath: job.staged_path,
        originalName: job.file_name,
        relativePath: job.relative_path,
        absolutePath: job.absolute_path
      });
      writeVectorManifest();
      db.prepare(`UPDATE extraction_jobs SET status = 'completed', json_file_name = ?, page_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(result.jsonFileName, result.extraction.pages?.length || 0, jobId);
    } catch (error) {
      db.prepare(`UPDATE extraction_jobs SET status = 'error', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error.message || 'Estrazione non riuscita.', jobId);
    }
  });
}

function resumePendingJobs() {
  db.prepare(`UPDATE extraction_jobs SET status = 'waiting', started_at = NULL WHERE status = 'processing'`).run();
  const pending = db.prepare(`SELECT id FROM extraction_jobs WHERE status = 'waiting' ORDER BY id`).all();
  pending.forEach((job) => queueJob(job.id));
}

function queueVectorizationJob(jobId) {
  setImmediate(async () => {
    const job = db.prepare('SELECT * FROM ai_vectorization_jobs WHERE id = ?').get(jobId);
    if (!job) return;
    db.prepare(`UPDATE ai_vectorization_jobs SET status = 'processing', started_at = CURRENT_TIMESTAMP, error = NULL WHERE id = ?`).run(jobId);
    try {
      const result = await vectorizeDatabase({
        jobId,
        collection: job.collection_name,
        embeddingModel: job.embedding_model,
        pageLimit: job.page_limit,
        batchSize: job.batch_size,
        force: Boolean(job.force_rebuild),
        onProgress: (progress) => db.prepare(`UPDATE ai_vectorization_jobs SET total_pages = ?, total_chunks = ?, completed_chunks = ?, vector_count = ?, input_tokens = ? WHERE id = ?`).run(progress.totalPages, progress.totalChunks, progress.completedChunks, progress.vectorCount, progress.inputTokens, jobId)
      });
      db.prepare(`UPDATE ai_vectorization_jobs SET status = 'completed', total_pages = ?, total_chunks = ?, completed_chunks = ?, vector_count = ?, input_tokens = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(result.pages, result.chunks, result.chunks, result.vectorCount, result.inputTokens, jobId);
    } catch (error) {
      updateVectorStoreManifest({ collection: job.collection_name, embeddingModel: job.embedding_model, vectorCount: vectorCollectionStats(job.collection_name).vectorCount, status: 'error', jobId });
      db.prepare(`UPDATE ai_vectorization_jobs SET status = 'error', error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(error.message || 'Vettorializzazione non riuscita.', jobId);
    }
  });
}

function resumeVectorizationJobs() {
  db.prepare(`UPDATE ai_requests SET status = 'error', error = 'Processo riavviato durante la vettorializzazione.', completed_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND question LIKE '[vectorize]%'`).run();
  db.prepare(`UPDATE ai_vectorization_jobs SET status = 'waiting', started_at = NULL WHERE status = 'processing'`).run();
}

function createVectorizationJob({ collection, embeddingModel, pageLimit, batchSize, force }) {
  vectorCollectionStats(collection); // valida il nome prima di creare il job.
  const jobId = crypto.randomUUID();
  db.prepare(`INSERT INTO ai_vectorization_jobs (id, collection_name, embedding_model, force_rebuild, page_limit, batch_size) VALUES (?, ?, ?, ?, ?, ?)`).run(jobId, collection, embeddingModel, force ? 1 : 0, pageLimit, batchSize);
  queueVectorizationJob(jobId);
  return { jobId, collection, embeddingModel, status: 'waiting', pageLimit, batchSize, force };
}

resumePendingJobs();
resumeVectorizationJobs();

app.get('/api/health', (_request, response) => response.json({ ok: true, service: 'rag-document-workspace-api' }));
app.get('/api/extract-queue', (request, response) => {
  const batchId = request.query.batchId ? String(request.query.batchId) : null;
  if (!batchId) return response.json(extractionQueue.status());
  const jobs = db.prepare(`SELECT id, batch_id AS batchId, file_name AS fileName, relative_path AS relativePath, status, error, json_file_name AS jsonFileName, page_count AS pageCount, created_at AS createdAt, completed_at AS completedAt FROM extraction_jobs WHERE batch_id = ? ORDER BY id`).all(batchId);
  const counts = jobs.reduce((result, job) => ({ ...result, [job.status]: (result[job.status] || 0) + 1 }), {});
  response.json({ batchId, jobs, counts, queue: extractionQueue.status() });
});

app.get('/api/stats', (_request, response) => {
  const stats = {
    documents: db.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
    pages: db.prepare('SELECT COUNT(*) AS count FROM pages').get().count,
    entities: db.prepare('SELECT COUNT(*) AS count FROM entities').get().count,
    relations: db.prepare('SELECT COUNT(*) AS count FROM relations').get().count,
    locations: db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'location'").get().count,
    years: db.prepare("SELECT COUNT(*) AS count FROM entities WHERE entity_type = 'year'").get().count
  };
  response.json(stats);
});

function searchTokens(value) {
  return [...new Set(normalizeValue(value)
    .replace(/[^a-z0-9àèéìòù' ]/gi, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2))];
}

function phraseValue(value) {
  return normalizeValue(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function directPhrase(value, tokens) {
  const normalized = phraseValue(value);
  if (tokens.length < 2 || /^(cerca|trova|mostrami|quali|quale|dove|chi|come|elenca|indicami|dimmi|fammi)\b/.test(normalized)) return null;
  return normalized;
}

function makeSearchSnippet(text, tokens) {
  const normalizedText = normalizeValue(text);
  const matchIndex = tokens.map((token) => normalizedText.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, matchIndex - 90);
  const end = Math.min(text.length, start + 260);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

app.get('/api/search', (request, response) => {
  const query = String(request.query.q || '').trim();
  const tokens = searchTokens(query);
  if (!query || !tokens.length) return response.json({ query, tokens, total: 0, results: [] });
  const exactPhrase = directPhrase(query, tokens);
  const normalizedQuery = phraseValue(query);

  const likeConditions = tokens.map(() => 'LOWER(p.text) LIKE ?').join(' OR ');
  const candidateRows = db.prepare(`
    SELECT p.id AS pageId, p.document_id AS documentId, p.page_number AS pageNumber, p.text,
      d.file_name AS fileName, d.title, d.absolute_path AS absolutePath
    FROM pages p
    JOIN documents d ON d.id = p.document_id
    WHERE ${likeConditions} OR LOWER(d.file_name) LIKE ?
    ORDER BY p.document_id, p.page_number
  `).all(...tokens.map((token) => `%${token}%`), `%${normalizeValue(query)}%`);
  const rows = exactPhrase
    ? candidateRows.filter((row) => phraseValue(row.text).includes(exactPhrase) || phraseValue(row.fileName).includes(exactPhrase))
    : candidateRows;

  const documents = new Map();
  for (const row of rows) {
    const normalizedText = phraseValue(row.text);
    const normalizedFileName = phraseValue(row.fileName);
    const matchedTerms = tokens.filter((token) => normalizedText.includes(token) || normalizedFileName.includes(token));
    const phraseMatch = normalizedQuery.length > 2 && (normalizedText.includes(normalizedQuery) || normalizedFileName.includes(normalizedQuery));
    const occurrences = matchedTerms.reduce((total, token) => total + (normalizedText.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 0);
    const score = matchedTerms.length * 20 + occurrences + (phraseMatch ? 35 : 0) + (normalizedFileName.includes(normalizeValue(query)) ? 12 : 0);
    if (!documents.has(row.documentId)) documents.set(row.documentId, {
      id: row.documentId,
      fileName: row.fileName,
      title: row.title,
      absolutePath: row.absolutePath,
      score: 0,
      matchedTerms: new Set(),
      pages: []
    });
    const result = documents.get(row.documentId);
    result.score += score;
    matchedTerms.forEach((term) => result.matchedTerms.add(term));
    result.pages.push({ pageId: row.pageId, pageNumber: row.pageNumber, score, snippet: makeSearchSnippet(row.text, tokens) });
  }

  const results = [...documents.values()]
    .map((result) => ({
      ...result,
      matchedTerms: [...result.matchedTerms],
      pages: result.pages.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber).slice(0, 8)
    }))
    .sort((a, b) => b.score - a.score || a.fileName.localeCompare(b.fileName))
    .slice(0, 100);
  response.json({ query, tokens, total: results.length, results });
});

app.get('/api/chat/sessions', (_request, response) => {
  const sessions = db.prepare(`
    SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt, COUNT(m.id) AS messageCount,
      COALESCE((SELECT content FROM chat_messages first_message WHERE first_message.session_id = s.id AND first_message.role = 'user' ORDER BY first_message.id LIMIT 1), '') AS firstMessage
    FROM chat_sessions s
    LEFT JOIN chat_messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY s.updated_at DESC, s.id DESC
  `).all();
  response.json({ sessions });
});

app.post('/api/chat/sessions', (_request, response) => {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO chat_sessions (id) VALUES (?)').run(id);
  const session = db.prepare('SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, 0 AS messageCount FROM chat_sessions WHERE id = ?').get(id);
  response.status(201).json(session);
});

app.get('/api/chat/sessions/:sessionId/messages', (request, response) => {
  const sessionId = String(request.params.sessionId);
  const session = db.prepare('SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM chat_sessions WHERE id = ?').get(sessionId);
  if (!session) return response.status(404).json({ error: 'Sessione RAG non trovata.' });
  const messages = db.prepare('SELECT id, role, content, metadata_json AS metadataJson, created_at AS createdAt FROM chat_messages WHERE session_id = ? ORDER BY created_at, id').all(sessionId).map((message) => {
    const metadata = parseJson(message.metadataJson, {});
    const { metadataJson, ...messageData } = message;
    return { ...messageData, ...metadata };
  });
  response.json({ session, messages });
});

app.post('/api/chat/sessions/:sessionId/messages', async (request, response) => {
  const sessionId = String(request.params.sessionId);
  const content = String(request.body?.content || '').trim();
  const session = db.prepare('SELECT id, title FROM chat_sessions WHERE id = ?').get(sessionId);
  if (!session) return response.status(404).json({ error: 'Sessione RAG non trovata.' });
  if (!content) return response.status(400).json({ error: 'Il messaggio non può essere vuoto.' });
  try {
    const history = db.prepare('SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT 8').all(sessionId).reverse();
    const aiResult = await runAIQuery({
      sessionId,
      question: content,
      instructions: request.body?.instructions || DEFAULT_INSTRUCTIONS,
      collection: request.body?.collection || DEFAULT_COLLECTION,
      topK: request.body?.topK,
      model: request.body?.model || DEFAULT_MODEL,
      embeddingModel: request.body?.embeddingModel || DEFAULT_EMBEDDING_MODEL,
      queryEmbedding: request.body?.queryEmbedding || null,
      history
    });
    const insertMessage = db.prepare('INSERT INTO chat_messages (session_id, role, content, metadata_json) VALUES (?, ?, ?, ?)');
    const userMetadata = { source: 'chat', requestId: aiResult.requestId, request: aiResult.structured.request };
    const assistantMetadata = { source: 'openai-rag', requestId: aiResult.requestId, structured: aiResult.structured, telemetry: aiResult.telemetry, databaseSnapshot: aiResult.databaseSnapshot, retrieval: aiResult.retrieval.map((item) => ({ id: item.id, score: item.score, metadata: item.metadata })) };
    const userResult = insertMessage.run(sessionId, 'user', content, JSON.stringify(userMetadata));
    const assistantResult = insertMessage.run(sessionId, 'assistant', aiResult.structured.message, JSON.stringify(assistantMetadata));
    const title = session.title === 'Nuova conversazione' ? content.slice(0, 80) : session.title;
    db.prepare('UPDATE chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, sessionId);
    const savedMessages = db.prepare('SELECT id, role, content, metadata_json AS metadataJson, created_at AS createdAt FROM chat_messages WHERE id IN (?, ?) ORDER BY created_at, id').all(Number(userResult.lastInsertRowid), Number(assistantResult.lastInsertRowid)).map((message) => {
      const metadata = parseJson(message.metadataJson, {});
      const { metadataJson, ...messageData } = message;
      return { ...messageData, ...metadata };
    });
    response.status(201).json({
      requestId: aiResult.requestId,
      structured: aiResult.structured,
      telemetry: aiResult.telemetry,
      databaseSnapshot: aiResult.databaseSnapshot,
      retrieval: aiResult.retrieval,
      messages: savedMessages
    });
  } catch (error) {
    response.status(error.status === 503 ? 503 : (error.status && error.status >= 400 && error.status < 500 ? 502 : 500)).json({ error: error.message || 'Richiesta AI non riuscita.', requestId: error.requestId || null });
  }
});

app.post('/api/ai/vector-store/:collection/ingest', (request, response) => {
  try {
    const documents = request.body?.documents || request.body?.vectors || [];
    const result = upsertVectorDocuments({ collection: request.params.collection, documents, embeddingModel: request.body?.embeddingModel || DEFAULT_EMBEDDING_MODEL });
    response.status(201).json({ ok: true, ...result });
  } catch (error) {
    response.status(400).json({ error: error.message || 'Ingestione vector store non riuscita.' });
  }
});

app.get('/api/ai/vector-store/:collection', (request, response) => {
  try {
    response.json(vectorStoreStatus(request.params.collection));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post('/api/ai/vector-store/:collection/vectorize', (request, response) => {
  if (!String(process.env.OPENAI_API_KEY || '').trim()) return response.status(503).json({ error: 'Configura OPENAI_API_KEY nel backend prima di vettorializzare il database.' });
  try {
    const collection = request.params.collection;
    const embeddingModel = String(request.body?.embeddingModel || DEFAULT_EMBEDDING_MODEL);
    const pageLimit = request.body?.pageLimit == null || request.body.pageLimit === '' ? null : Math.min(Math.max(Number(request.body.pageLimit) || 1, 1), 1000000);
    const batchSize = Math.min(Math.max(Number(request.body?.batchSize) || 64, 1), 100);
    const force = Boolean(request.body?.force);
    response.status(202).json(createVectorizationJob({ collection, embeddingModel, pageLimit, batchSize, force }));
  } catch (error) {
    response.status(400).json({ error: error.message || 'Impossibile avviare la vettorializzazione.' });
  }
});

app.post('/api/ai/vector-store/:collection/sync', (request, response) => {
  if (!String(process.env.OPENAI_API_KEY || '').trim()) return response.status(503).json({ error: 'OPENAI_API_KEY non configurata.', upToDate: false, indexingAvailable: false });
  try {
    const status = vectorStoreStatus(request.params.collection);
    if (status.upToDate) return response.json({ ...status, status: 'ready', indexingAvailable: true });
    if (status.activeJob) {
      if (status.activeJob.status === 'waiting') queueVectorizationJob(status.activeJob.jobId);
      return response.status(202).json({ ...status, status: status.activeJob.status, jobId: status.activeJob.jobId, indexingAvailable: true });
    }
    const job = createVectorizationJob({ collection: request.params.collection, embeddingModel: request.body?.embeddingModel || DEFAULT_EMBEDDING_MODEL, pageLimit: null, batchSize: 64, force: false });
    response.status(202).json({ ...status, ...job, reason: 'source_manifest_changed', indexingAvailable: true });
  } catch (error) {
    response.status(400).json({ error: error.message || 'Impossibile sincronizzare il vector store.' });
  }
});

app.get('/api/ai/vector-store/:collection/vectorize/:jobId', (request, response) => {
  const job = db.prepare(`SELECT id AS jobId, collection_name AS collection, embedding_model AS embeddingModel, status, force_rebuild AS force, page_limit AS pageLimit, batch_size AS batchSize, total_pages AS totalPages, total_chunks AS totalChunks, completed_chunks AS completedChunks, vector_count AS vectorCount, input_tokens AS inputTokens, error, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM ai_vectorization_jobs WHERE id = ? AND collection_name = ?`).get(request.params.jobId, request.params.collection);
  if (!job) return response.status(404).json({ error: 'Job di vettorializzazione non trovato.' });
  response.json({ ...job, force: Boolean(job.force), progress: job.totalChunks ? Math.round((job.completedChunks / job.totalChunks) * 100) : (job.status === 'completed' ? 100 : 0) });
});

app.get('/api/ai/requests', (request, response) => {
  response.json({ requests: aiRequestRows({ limit: request.query.limit, sessionId: request.query.sessionId ? String(request.query.sessionId) : null }) });
});

app.get('/api/ai/requests/:requestId', (request, response) => {
  const result = aiRequestById(request.params.requestId);
  if (!result) return response.status(404).json({ error: 'Richiesta AI non trovata.' });
  response.json(result);
});

app.post('/api/ai/query', async (request, response) => {
  const question = String(request.body?.question || request.body?.content || '').trim();
  if (!question) return response.status(400).json({ error: 'question è obbligatoria.' });
  try {
    const result = await runAIQuery({
      question,
      instructions: request.body?.instructions || DEFAULT_INSTRUCTIONS,
      collection: request.body?.collection || DEFAULT_COLLECTION,
      topK: request.body?.topK,
      model: request.body?.model || DEFAULT_MODEL,
      embeddingModel: request.body?.embeddingModel || DEFAULT_EMBEDDING_MODEL,
      queryEmbedding: request.body?.queryEmbedding || null
    });
    response.json(result);
  } catch (error) {
    response.status(error.status === 503 ? 503 : (error.status && error.status >= 400 && error.status < 500 ? 502 : 500)).json({ error: error.message || 'Richiesta AI non riuscita.', requestId: error.requestId || null });
  }
});


app.get('/api/documents', (request, response) => {
  const search = String(request.query.search || '').trim().toLowerCase();
  const location = String(request.query.location || '').trim().toLowerCase();
  const year = String(request.query.year || '').trim().toLowerCase();
  const requestedPage = Number(request.query.page || 1);
  const requestedPageSize = Number(request.query.pageSize || 20);
  const pageSize = Number.isFinite(requestedPageSize) ? Math.min(Math.max(Math.floor(requestedPageSize), 10), 50) : 20;
  const documents = db.prepare(`
    SELECT d.id, d.source_key AS sourceKey, d.file_name AS fileName, d.title, d.mime_type AS mimeType,
      d.imported_at AS importedAt, COUNT(DISTINCT p.id) AS pageCount, COUNT(DISTINCT de.entity_id) AS entityCount
    FROM documents d
    LEFT JOIN pages p ON p.document_id = d.id
    LEFT JOIN document_entities de ON de.document_id = d.id
    GROUP BY d.id
    ORDER BY d.imported_at DESC, d.id DESC
  `).all();
  const filtered = documents.filter((document) => {
    const entities = db.prepare(`SELECT e.entity_type AS type, e.value FROM document_entities de JOIN entities e ON e.id = de.entity_id WHERE de.document_id = ?`).all(document.id);
    const haystack = [document.fileName, document.title, document.sourceKey, ...entities.map((entity) => entity.value)].filter(Boolean).join(' ').toLowerCase();
    const hasLocation = !location || entities.some((entity) => entity.type === 'location' && entity.value.toLowerCase().includes(location));
    const hasYear = !year || entities.some((entity) => entity.type === 'year' && entity.value.toLowerCase().includes(year));
    return (!search || haystack.includes(search)) && hasLocation && hasYear;
  });
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Number.isFinite(requestedPage) ? Math.min(Math.max(Math.floor(requestedPage), 1), pages) : 1;
  response.json({ documents: filtered.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages });
});

app.get('/api/documents/:id', (request, response) => {
  const id = Number(request.params.id);
  const document = db.prepare(`SELECT id, source_key AS sourceKey, file_name AS fileName, absolute_path AS absolutePath, title, mime_type AS mimeType, checksum, metadata_json AS metadataJson, imported_at AS importedAt FROM documents WHERE id = ?`).get(id);
  if (!document) return response.status(404).json({ error: 'Documento non trovato.' });
  document.metadata = parseJson(document.metadataJson, {});
  delete document.metadataJson;
  document.pages = db.prepare(`SELECT id, page_number AS pageNumber, text, extracted_json AS extractedJson FROM pages WHERE document_id = ? ORDER BY page_number`).all(id).map((page) => ({
    ...page,
    extracted: parseJson(page.extractedJson, {}),
    entities: db.prepare(`SELECT e.entity_type AS type, e.value, pe.raw_value AS rawValue, pe.confidence FROM page_entities pe JOIN entities e ON e.id = pe.entity_id WHERE pe.page_id = ? ORDER BY e.entity_type, e.value`).all(page.id)
  }));
  document.entities = db.prepare(`SELECT e.entity_type AS type, e.value, de.occurrences, de.page_numbers_json AS pageNumbersJson FROM document_entities de JOIN entities e ON e.id = de.entity_id WHERE de.document_id = ? ORDER BY e.entity_type, e.value`).all(id).map((entity) => ({
    type: entity.type,
    value: entity.value,
    occurrences: entity.occurrences,
    pageNumbers: parseJson(entity.pageNumbersJson, [])
  }));
  response.json(document);
});

app.get('/api/relations', (request, response) => {
  const documentId = request.query.documentId ? Number(request.query.documentId) : null;
  const requestedLimit = Number(request.query.limit || 20);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500) : 20;
  const relations = db.prepare(`
    SELECT r.id, r.score, r.shared_entities_json AS sharedEntitiesJson,
      a.id AS documentAId, a.file_name AS documentAFileName, a.title AS documentATitle,
      b.id AS documentBId, b.file_name AS documentBFileName, b.title AS documentBTitle
    FROM relations r
    JOIN documents a ON a.id = r.document_a_id
    JOIN documents b ON b.id = r.document_b_id
    WHERE (? IS NULL OR r.document_a_id = ? OR r.document_b_id = ?)
    ORDER BY r.score DESC, r.id DESC
    LIMIT ${limit}
  `).all(documentId, documentId, documentId).map((relation) => {
    const { sharedEntitiesJson, ...relationData } = relation;
    const sharedEntities = parseJson(relation.sharedEntitiesJson, []);
    const previewEntities = sharedEntities.slice(0, 24).map((entity) => ({
      ...entity,
      pageCountA: Array.isArray(entity.pagesA) ? entity.pagesA.length : 0,
      pageCountB: Array.isArray(entity.pagesB) ? entity.pagesB.length : 0,
      pagesA: Array.isArray(entity.pagesA) ? entity.pagesA.slice(0, 20) : [],
      pagesB: Array.isArray(entity.pagesB) ? entity.pagesB.slice(0, 20) : []
    }));
    return {
      ...relationData,
      sharedEntityCount: sharedEntities.length,
      sharedEntities: previewEntities
    };
  });
  response.json({ relations });
});

app.get('/api/graph', (_request, response) => {
  const nodes = db.prepare('SELECT id, file_name AS label, title FROM documents ORDER BY id').all();
  const edges = db.prepare('SELECT id, document_a_id AS source, document_b_id AS target, score, shared_entities_json AS sharedEntitiesJson FROM relations ORDER BY score DESC').all().map((edge) => ({ ...edge, sharedEntities: parseJson(edge.sharedEntitiesJson, []) }));
  response.json({ nodes, edges });
});

app.post('/api/database/access', (request, response) => {
  const { username, password } = request.body || {};
  if (username !== DEMO_DATABASE_USER || password !== DEMO_DATABASE_PASSWORD) return response.status(401).json({ error: 'Credenziali demo non valide.' });
  response.json({ accessToken: DEMO_DATABASE_TOKEN, username: DEMO_DATABASE_USER });
});

app.get('/api/database', (request, response) => {
  if (request.headers['x-demo-access'] !== DEMO_DATABASE_TOKEN) return response.status(401).json({ error: 'Accesso al pannello database non autorizzato.' });
  const table = String(request.query.table || 'documents');
  const queries = {
    documents: {
      columns: ['id', 'file_name', 'absolute_path', 'title', 'imported_at'],
      sql: 'SELECT id, file_name, absolute_path, title, imported_at FROM documents ORDER BY id DESC LIMIT 500'
    },
    pages: {
      columns: ['id', 'document_id', 'page_number', 'text'],
      sql: `SELECT id, document_id, page_number, substr(text, 1, 240) AS text FROM pages ORDER BY document_id DESC, page_number LIMIT 1000`
    },
    entities: {
      columns: ['id', 'entity_type', 'value', 'normalized_value'],
      sql: 'SELECT id, entity_type, value, normalized_value FROM entities ORDER BY entity_type, value LIMIT 1000'
    },
    relations: {
      columns: ['id', 'document_a_id', 'document_b_id', 'score', 'shared_entities'],
      sql: 'SELECT id, document_a_id, document_b_id, score, shared_entities_json AS shared_entities FROM relations ORDER BY score DESC LIMIT 1000'
    },
    ai_requests: {
      columns: ['id', 'session_id', 'collection_name', 'question', 'model', 'status', 'input_tokens', 'output_tokens', 'total_tokens', 'latency_ms', 'created_at'],
      sql: 'SELECT id, session_id, collection_name, question, model, status, input_tokens, output_tokens, total_tokens, latency_ms, created_at FROM ai_requests ORDER BY created_at DESC LIMIT 500'
    },
    ai_vectors: {
      columns: ['id', 'collection_name', 'external_id', 'text', 'metadata_json'],
      sql: 'SELECT id, collection_name, external_id, substr(text, 1, 240) AS text, metadata_json FROM ai_vectors ORDER BY id DESC LIMIT 1000'
    },
    ai_vectorization_jobs: {
      columns: ['id', 'collection_name', 'embedding_model', 'status', 'total_pages', 'total_chunks', 'completed_chunks', 'vector_count', 'input_tokens', 'error', 'created_at', 'completed_at'],
      sql: 'SELECT id, collection_name, embedding_model, status, total_pages, total_chunks, completed_chunks, vector_count, input_tokens, error, created_at, completed_at FROM ai_vectorization_jobs ORDER BY created_at DESC LIMIT 200'
    },
    ai_manifests: {
      columns: ['collection_name', 'source_revision', 'source_metadata_updated_at', 'vectorized_at', 'embedding_model', 'vector_count', 'status', 'last_job_id'],
      sql: 'SELECT collection_name, source_revision, source_metadata_updated_at, vectorized_at, embedding_model, vector_count, status, last_job_id FROM ai_manifests ORDER BY collection_name'
    },
    source_manifest: {
      columns: ['id', 'revision', 'metadata_updated_at'],
      sql: 'SELECT id, revision, metadata_updated_at FROM source_manifest'
    }
  };
  if (!queries[table]) return response.status(400).json({ error: 'Tabella non disponibile.' });
  const counts = Object.fromEntries(Object.keys(queries).map((name) => [name, db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count]));
  const result = queries[table];
  response.json({ table, columns: result.columns, rows: db.prepare(result.sql).all(), counts });
});

app.delete('/api/database/history', async (request, response) => {
  if (request.headers['x-demo-access'] !== DEMO_DATABASE_TOKEN) return response.status(401).json({ error: 'Accesso al pannello database non autorizzato.' });
  const queueStatus = extractionQueue.status();
  if (queueStatus.active || queueStatus.waiting > 0) return response.status(409).json({ error: 'Attendi la fine della coda di estrazione prima di pulire lo storico.' });
  const deleted = transaction(() => {
    const counts = {
      relations: db.prepare('SELECT COUNT(*) AS count FROM relations').get().count,
      documents: db.prepare('SELECT COUNT(*) AS count FROM documents').get().count,
      pages: db.prepare('SELECT COUNT(*) AS count FROM pages').get().count,
      entities: db.prepare('SELECT COUNT(*) AS count FROM entities').get().count,
      extractionJobs: db.prepare('SELECT COUNT(*) AS count FROM extraction_jobs').get().count,
      chatSessions: db.prepare('SELECT COUNT(*) AS count FROM chat_sessions').get().count,
      chatMessages: db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count,
      aiRequests: db.prepare('SELECT COUNT(*) AS count FROM ai_requests').get().count,
      aiVectorizationJobs: db.prepare('SELECT COUNT(*) AS count FROM ai_vectorization_jobs').get().count
    };
    db.exec('DELETE FROM extraction_jobs; DELETE FROM ai_vectorization_jobs; DELETE FROM ai_requests; DELETE FROM chat_messages; DELETE FROM chat_sessions; DELETE FROM relations; DELETE FROM document_entities; DELETE FROM page_entities; DELETE FROM pages; DELETE FROM documents; DELETE FROM entities;');
    return counts;
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
  writeVectorManifest();
  const clearDirectory = async (directory) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => fsp.unlink(path.join(directory, entry.name))));
  };
  await clearDirectory(extractionsDirectory);
  await clearDirectory(uploadsDirectory);
  response.json({ cleared: true, deleted });
});

app.post('/api/extract-file', upload.single('file'), async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'Nessun file ricevuto.' });
  try {
    const result = await extractionQueue.enqueue(() => extractAndPersist({
      inputPath: request.file.path,
      originalName: request.file.originalname,
      relativePath: request.body.relativePath || request.file.originalname,
      absolutePath: request.body.absolutePath || null
    }));
    writeVectorManifest();
    response.status(201).json({
      message: 'File estratto e importato nel grafo.',
      fileName: request.file.originalname,
      jsonFileName: result.jsonFileName,
      extraction: result.extraction,
      imported: result.imported,
      databaseSaved: result.databaseSaved
    });
  } catch (error) {
    response.status(422).json({ error: error.message || 'Estrazione non riuscita.' });
  }
});

app.post('/api/extract-batch', upload.array('files'), (request, response) => {
  const files = request.files || [];
  if (!files.length) return response.status(400).json({ error: 'Nessun file ricevuto.' });
  const batchId = crypto.randomUUID();
  const relativePaths = Array.isArray(request.body.relativePaths) ? request.body.relativePaths : [request.body.relativePaths || ''];
  const absolutePaths = Array.isArray(request.body.absolutePaths) ? request.body.absolutePaths : [request.body.absolutePaths || ''];
  const insert = db.prepare(`INSERT INTO extraction_jobs (batch_id, source_key, file_name, relative_path, staged_path, absolute_path) VALUES (?, ?, ?, ?, ?, ?)`);
  const jobs = transaction(() => files.map((file, index) => {
    const relativePath = String(relativePaths[index] || file.originalname).replaceAll('\\', '/');
    const result = insert.run(batchId, relativePath, file.originalname, relativePath, file.path, absolutePaths[index] || null);
    return { id: Number(result.lastInsertRowid), batchId, fileName: file.originalname, relativePath, status: 'waiting' };
  }));
  jobs.forEach((job) => queueJob(job.id));
  response.status(202).json({ batchId, jobs, queue: extractionQueue.status() });
});

app.get('/api/extractions/:fileName', (request, response) => {
  const fileName = path.basename(request.params.fileName);
  if (fileName !== request.params.fileName || !fileName.endsWith('.json')) return response.status(400).json({ error: 'Nome file non valido.' });
  response.download(path.join(extractionsDirectory, fileName), fileName, (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: 'JSON di estrazione non trovato.' });
  });
});

app.post('/api/relations/rebuild', (_request, response) => response.json(rebuildRelations()));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Errore interno del server.' });
});

app.listen(port, () => console.log(`RAG API in ascolto su http://localhost:${port}`));
