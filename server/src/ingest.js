import crypto from 'node:crypto';
import { db, normalizeType, normalizeValue, serialize, transaction } from './db.js';

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function entityCandidates(value, defaultType = 'keyword') {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => entityCandidates(item, defaultType));
  if (typeof value === 'string' || typeof value === 'number') {
    return [{ type: defaultType, value: String(value) }];
  }
  if (typeof value === 'object') {
    if ('value' in value || 'name' in value || 'label' in value) {
      return [{
        type: value.type || value.kind || defaultType,
        value: value.value ?? value.name ?? value.label,
        confidence: value.confidence,
        rawValue: value.rawValue
      }];
    }
    return Object.entries(value).flatMap(([key, item]) => {
      if (['location', 'year', 'keyword', 'keywords', 'person', 'people', 'organization'].includes(normalizeType(key))) {
        return entityCandidates(item, normalizeType(key));
      }
      return [];
    });
  }
  return [];
}

function collectEntities(container) {
  if (!container || typeof container !== 'object') return [];
  const explicit = [
    ...entityCandidates(container.entities),
    ...entityCandidates(container.keywords, 'keyword'),
    ...entityCandidates(container.fields)
  ];
  const unique = new Map();
  for (const candidate of explicit) {
    const value = String(candidate.value ?? '').trim();
    if (!value) continue;
    const type = normalizeType(candidate.type);
    if (type === 'location' || type === 'year') continue;
    const key = `${type}:${normalizeValue(value)}`;
    if (!unique.has(key)) unique.set(key, { ...candidate, type, value });
  }
  return [...unique.values()];
}

const TEXT_STOP_WORDS = new Set([
  'della', 'delle', 'degli', 'dello', 'dell', 'alla', 'alle', 'agli', 'allo', 'nella', 'nelle', 'negli', 'nello',
  'questo', 'questa', 'questi', 'quelle', 'quello', 'sono', 'come', 'dove', 'quando', 'anche', 'con', 'per', 'tra',
  'fra', 'del', 'dei', 'dal', 'dai', 'sul', 'sui', 'una', 'uno', 'gli', 'che', 'non', 'nel', 'nei', 'piu', 'più',
  'the', 'and', 'from', 'with', 'that', 'this', 'have', 'were', 'been', 'for', 'are', 'was', 'not'
]);

export function textTerms(text) {
  return new Set(normalizeValue(text)
    .replace(/[^a-z0-9àèéìòù' ]/gi, ' ')
    .split(/\s+/)
    .filter((term) => term.length >= 4 && !TEXT_STOP_WORDS.has(term) && !/^\d+$/.test(term)));
}

function normalizeInput(payload) {
  const rawDocuments = Array.isArray(payload) ? payload : payload?.documents || payload?.document || [];
  return asArray(rawDocuments).map((rawDocument, documentIndex) => {
    const pages = asArray(rawDocument.pages || rawDocument.page || rawDocument.content).map((rawPage, pageIndex) => ({
      pageNumber: Number(rawPage.pageNumber ?? rawPage.page ?? rawPage.number ?? pageIndex + 1),
      text: String(rawPage.text ?? rawPage.content ?? rawPage.ocrText ?? ''),
      extracted: rawPage.extracted ?? rawPage.blocks ?? rawPage,
      entities: collectEntities(rawPage)
    }));
    const fallbackKey = rawDocument.sourceKey || rawDocument.source || rawDocument.fileName || rawDocument.filename || `document-${documentIndex + 1}`;
    return {
      sourceKey: String(fallbackKey),
      fileName: String(rawDocument.fileName || rawDocument.filename || rawDocument.name || fallbackKey),
      absolutePath: rawDocument.absolutePath || rawDocument.absolute_path || null,
      title: rawDocument.title ? String(rawDocument.title) : null,
      mimeType: rawDocument.mimeType || rawDocument.mime_type || null,
      checksum: rawDocument.checksum || null,
      metadata: rawDocument.metadata || {},
      entities: collectEntities(rawDocument),
      pages
    };
  });
}

function getOrCreateEntity(candidate) {
  const type = normalizeType(candidate.type);
  const value = String(candidate.value).trim();
  const normalizedValue = normalizeValue(value);
  db.prepare(`
    INSERT INTO entities (entity_type, value, normalized_value)
    VALUES (?, ?, ?)
    ON CONFLICT(entity_type, normalized_value) DO UPDATE SET value = excluded.value
  `).run(type, value, normalizedValue);
  return db.prepare('SELECT id, entity_type, value FROM entities WHERE entity_type = ? AND normalized_value = ?').get(type, normalizedValue);
}

function attachDocumentEntity(documentId, entityId, pageNumber = null) {
  const current = db.prepare('SELECT occurrences, page_numbers_json FROM document_entities WHERE document_id = ? AND entity_id = ?').get(documentId, entityId);
  const pages = current ? JSON.parse(current.page_numbers_json) : [];
  if (pageNumber != null && !pages.includes(pageNumber)) pages.push(pageNumber);
  db.prepare(`
    INSERT INTO document_entities (document_id, entity_id, occurrences, page_numbers_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(document_id, entity_id) DO UPDATE SET
      occurrences = excluded.occurrences,
      page_numbers_json = excluded.page_numbers_json
  `).run(documentId, entityId, (current?.occurrences || 0) + 1, serialize(pages.sort((a, b) => a - b), []));
}

export function ingest(payload) {
  const documents = normalizeInput(payload);
  if (!documents.length) throw new Error('Il JSON non contiene documenti importabili.');
  const importDocuments = transaction(() => {
    const imported = [];
    for (const document of documents) {
      const checksum = document.checksum || crypto.createHash('sha1').update(`${document.sourceKey}:${document.pages.map((page) => page.text).join('|')}`).digest('hex');
      const existing = db.prepare('SELECT id FROM documents WHERE source_key = ?').get(document.sourceKey);
      let documentId;
      if (existing) {
        documentId = existing.id;
        db.prepare('DELETE FROM document_entities WHERE document_id = ?').run(documentId);
        db.prepare('DELETE FROM pages WHERE document_id = ?').run(documentId);
        db.prepare(`UPDATE documents SET file_name = ?, absolute_path = ?, title = ?, mime_type = ?, checksum = ?, metadata_json = ?, imported_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(document.fileName, document.absolutePath, document.title, document.mimeType, checksum, serialize(document.metadata), documentId);
      } else {
        const result = db.prepare(`INSERT INTO documents (source_key, file_name, absolute_path, title, mime_type, checksum, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(document.sourceKey, document.fileName, document.absolutePath, document.title, document.mimeType, checksum, serialize(document.metadata));
        documentId = result.lastInsertRowid;
      }

      for (const page of document.pages) {
        const pageResult = db.prepare(`INSERT INTO pages (document_id, page_number, text, extracted_json) VALUES (?, ?, ?, ?)`)
          .run(documentId, page.pageNumber, page.text, serialize(page.extracted));
        for (const candidate of page.entities) {
          const entity = getOrCreateEntity(candidate);
          db.prepare(`INSERT OR IGNORE INTO page_entities (page_id, entity_id, raw_value, confidence, source) VALUES (?, ?, ?, ?, ?)`)
            .run(pageResult.lastInsertRowid, entity.id, candidate.rawValue || candidate.value, candidate.confidence ?? null, 'ocr-json');
          attachDocumentEntity(documentId, entity.id, page.pageNumber);
        }
      }
      for (const candidate of document.entities) {
        const entity = getOrCreateEntity(candidate);
        attachDocumentEntity(documentId, entity.id);
      }
      imported.push({ id: documentId, fileName: document.fileName, pages: document.pages.length });
    }
    return imported;
  });

  refreshRelationsForDocuments(importDocuments.map((document) => document.id));
  return importDocuments;
}

function buildDocumentTerms() {
  const rows = db.prepare('SELECT document_id, page_number, text FROM pages ORDER BY document_id, page_number').all();
  const byDocument = new Map();
  for (const row of rows) {
    if (!byDocument.has(row.document_id)) byDocument.set(row.document_id, new Map());
    for (const term of textTerms(row.text)) {
      if (!byDocument.get(row.document_id).has(term)) byDocument.get(row.document_id).set(term, new Set());
      byDocument.get(row.document_id).get(term).add(row.page_number);
    }
  }
  return byDocument;
}

function makeRelation(aId, aEntities, bId, bEntities) {
  const shared = [...aEntities.keys()]
    .filter((term) => bEntities.has(term))
    .map((term) => ({
      type: 'text',
      value: term,
      pagesA: [...aEntities.get(term)].sort((a, b) => a - b),
      pagesB: [...bEntities.get(term)].sort((a, b) => a - b)
    }));
  if (shared.length < 2) return null;
  const score = Number((shared.length + Math.min(shared.length, 10) / 10).toFixed(2));
  return { aId, bId, score, shared };
}

export function refreshRelationsForDocuments(documentIds) {
  const byDocument = buildDocumentTerms();
  const allDocumentIds = [...byDocument.keys()].sort((a, b) => a - b);
  const targetIds = [...new Set(documentIds.map(Number))].filter((id) => byDocument.has(id));
  const pairs = new Set();
  const relationRows = [];

  for (const targetId of targetIds) {
    for (const otherId of allDocumentIds) {
      if (targetId === otherId) continue;
      const aId = Math.min(targetId, otherId);
      const bId = Math.max(targetId, otherId);
      const pairKey = `${aId}:${bId}`;
      if (pairs.has(pairKey)) continue;
      pairs.add(pairKey);
      const relation = makeRelation(aId, byDocument.get(aId), bId, byDocument.get(bId));
      relationRows.push(relation);
    }
  }

  transaction(() => {
    const remove = db.prepare('DELETE FROM relations WHERE document_a_id = ? AND document_b_id = ?');
    const insert = db.prepare('INSERT INTO relations (document_a_id, document_b_id, score, shared_entities_json) VALUES (?, ?, ?, ?)');
    for (const pairKey of pairs) {
      const [aId, bId] = pairKey.split(':').map(Number);
      remove.run(aId, bId);
    }
    for (const relation of relationRows) {
      if (relation) insert.run(relation.aId, relation.bId, relation.score, serialize(relation.shared, []));
    }
  });

  return { relations: relationRows.filter(Boolean).length, documents: targetIds.length };
}

export function rebuildRelations() {
  const byDocument = buildDocumentTerms();
  const documentIds = [...byDocument.keys()].sort((a, b) => a - b);
  const relationRows = [];
  for (let index = 0; index < documentIds.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < documentIds.length; otherIndex += 1) {
      const aId = documentIds[index];
      const bId = documentIds[otherIndex];
      const relation = makeRelation(aId, byDocument.get(aId), bId, byDocument.get(bId));
      if (relation) relationRows.push(relation);
    }
  }
  transaction(() => {
    db.prepare('DELETE FROM relations').run();
    const insert = db.prepare('INSERT INTO relations (document_a_id, document_b_id, score, shared_entities_json) VALUES (?, ?, ?, ?)');
    for (const relation of relationRows) insert.run(relation.aId, relation.bId, relation.score, serialize(relation.shared, []));
  });
  return { relations: relationRows.length };
}
