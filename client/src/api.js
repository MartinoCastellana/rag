async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Richiesta non riuscita');
  return data;
}

export const api = {
  stats: () => request('/api/stats'),
  semanticSearch: (query) => request(`/api/search?q=${encodeURIComponent(query)}`),
  chatSessions: () => request('/api/chat/sessions'),
  createChatSession: () => request('/api/chat/sessions', { method: 'POST' }),
  chatMessages: (sessionId) => request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`),
  sendChatMessage: (sessionId, content, options = {}) => request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, ...options }) }),
  aiQuery: (question, options = {}) => request('/api/ai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, ...options }) }),
  ingestVectors: (collection, payload) => request(`/api/ai/vector-store/${encodeURIComponent(collection)}/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  vectorStore: (collection) => request(`/api/ai/vector-store/${encodeURIComponent(collection)}`),
  vectorizeDatabase: (collection, options = {}) => request(`/api/ai/vector-store/${encodeURIComponent(collection)}/vectorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) }),
  vectorizationJob: (collection, jobId) => request(`/api/ai/vector-store/${encodeURIComponent(collection)}/vectorize/${encodeURIComponent(jobId)}`),
  syncVectorStore: (collection, options = {}) => request(`/api/ai/vector-store/${encodeURIComponent(collection)}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) }),
  aiRequests: (limit = 50) => request(`/api/ai/requests?limit=${encodeURIComponent(limit)}`),
  aiRequest: (requestId) => request(`/api/ai/requests/${encodeURIComponent(requestId)}`),
  documents: (filters = {}, page = 1, pageSize = 20) => {
    const params = new URLSearchParams({ ...filters, page: String(page), pageSize: String(pageSize) });
    return request(`/api/documents?${params}`);
  },
  relations: (documentId, limit = 20) => {
    const params = new URLSearchParams();
    if (documentId) params.set('documentId', documentId);
    if (limit) params.set('limit', limit);
    return request(`/api/relations?${params.toString()}`);
  },
  document: (id) => request(`/api/documents/${id}`),
  databaseAccess: (credentials) => request('/api/database/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) }),
  databaseTable: (table, accessToken) => request(`/api/database?table=${encodeURIComponent(table)}`, { headers: { 'x-demo-access': accessToken } }),
  clearHistory: (accessToken) => request('/api/database/history', { method: 'DELETE', headers: { 'x-demo-access': accessToken } }),
  extractFile: (file, relativePath, absolutePath) => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    formData.append('relativePath', relativePath || file.name);
    if (absolutePath) formData.append('absolutePath', absolutePath);
    return request('/api/extract-file', { method: 'POST', body: formData });
  },
  extractBatch: (files) => {
    const formData = new FormData();
    files.forEach((item) => {
      formData.append('files', item.file, item.file.name);
      formData.append('relativePaths', item.relativePath || item.file.name);
      formData.append('absolutePaths', item.absolutePath || '');
    });
    return request('/api/extract-batch', { method: 'POST', body: formData });
  },
  extractQueue: (batchId) => request(`/api/extract-queue?batchId=${encodeURIComponent(batchId)}`),
  rebuildRelations: () => request('/api/relations/rebuild', { method: 'POST' })
};
