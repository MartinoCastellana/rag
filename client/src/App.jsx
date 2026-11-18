import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';

const emptyStats = { documents: 0, pages: 0, entities: 0, relations: 0, locations: 0, years: 0 };
const supportedExtensions = ['.pdf'];
const queueStorageKey = 'rag-extraction-queue-v1';

function readPersistedQueue() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(queueStorageKey) || '[]');
    return Array.isArray(saved) ? saved.map((item) => ({
      ...item,
      file: null,
      status: item.status === 'processing' ? 'waiting' : item.status,
      error: item.status === 'processing' ? 'Pagina aggiornata: ricollega la cartella per riprendere questo file.' : item.error || ''
    })) : [];
  } catch {
    return [];
  }
}

function StatCard({ label, value, detail, accent }) {
  return <div className={`stat-card ${accent || ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function EntityPill({ entity }) {
  const label = entity.type === 'text' ? 'testo' : entity.type;
  return <span className={`entity-pill ${entity.type}`}>{label}: {entity.value}</span>;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function highlightSearchText(value, terms = []) {
  const safeText = escapeHtml(value);
  const safeTerms = [...new Set(terms.map((term) => String(term || '').trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!safeTerms.length) return safeText;
  return safeText.replace(new RegExp(`(${safeTerms.join('|')})`, 'gi'), '<mark class="search-highlight">$1</mark>');
}

function markdownToHtml(value) {
  const lines = String(value ?? '').split(/\r?\n/).map((line) => escapeHtml(line));
  const html = [];
  const formatInline = (line) => line
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(?!\s)(.+?)(?<!\s)\*/g, '<em>$1</em>');
  const splitTableRow = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const isTableSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const isListLine = (line) => /^\s*(?:[-*+]\s+|\d+[.]\s+)/.test(line);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push(`<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${headers.map((cell) => `<th>${formatInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${formatInline(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (isListLine(line)) {
      const ordered = /^\s*\d+[.]\s+/.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const itemPattern = ordered ? /^\s*\d+[.]\s+/ : /^\s*[-*+]\s+/;
      const items = [];
      while (index < lines.length && isListLine(lines[index]) && (ordered === /^\s*\d+[.]\s+/.test(lines[index]))) {
        items.push(lines[index].replace(itemPattern, ''));
        index += 1;
      }
      html.push(`<${tag}>${items.map((item) => `<li>${formatInline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^###\s+/.test(line)) { html.push(`<h4>${formatInline(line.replace(/^###\s+/, ''))}</h4>`); index += 1; continue; }
    if (/^##\s+/.test(line)) { html.push(`<h3>${formatInline(line.replace(/^##\s+/, ''))}</h3>`); index += 1; continue; }
    if (/^#\s+/.test(line)) { html.push(`<h3>${formatInline(line.replace(/^#\s+/, ''))}</h3>`); index += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^>\s?/, '')); index += 1; }
      html.push(`<blockquote>${formatInline(quote.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { html.push('<hr />'); index += 1; continue; }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isListLine(lines[index]) && !/^#{1,3}\s+/.test(lines[index]) && !/^>\s?/.test(lines[index])) {
      if (index + 1 < lines.length && lines[index].includes('|') && isTableSeparator(lines[index + 1])) break;
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${formatInline(paragraph.join(' '))}</p>`);
  }
  return html.join('');
}

function MarkdownMessage({ content }) {
  return <div className="markdown-message" dangerouslySetInnerHTML={{ __html: markdownToHtml(content) }} />;
}

function TypewriterMessage({ content }) {
  const [visibleLength, setVisibleLength] = useState(0);
  useEffect(() => {
    const text = String(content || '');
    let currentLength = 0;
    const chunkSize = Math.max(2, Math.ceil(text.length / 120));
    setVisibleLength(0);
    if (!text) return undefined;
    const timer = window.setInterval(() => {
      currentLength = Math.min(text.length, currentLength + chunkSize);
      setVisibleLength(currentLength);
      if (currentLength >= text.length) window.clearInterval(timer);
    }, 24);
    return () => window.clearInterval(timer);
  }, [content]);
  const visibleContent = String(content || '').slice(0, visibleLength);
  const complete = visibleLength >= String(content || '').length;
  return <div className="markdown-stream"><MarkdownMessage content={visibleContent} />{!complete && <span className="typewriter-cursor" aria-hidden="true">▌</span>}</div>;
}

function App() {
  const [stats, setStats] = useState(emptyStats);
  const [documents, setDocuments] = useState([]);
  const [relations, setRelations] = useState([]);
  const [filters, setFilters] = useState({ search: '' });
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [queue, setQueue] = useState(readPersistedQueue);
  const [folderName, setFolderName] = useState(() => window.localStorage.getItem('rag-extraction-folder') || '');
  const [extracting, setExtracting] = useState(false);
  const [databaseCredentials, setDatabaseCredentials] = useState({ username: '', password: '' });
  const [databaseToken, setDatabaseToken] = useState('');
  const [databaseAccess, setDatabaseAccess] = useState(false);
  const [databaseTable, setDatabaseTable] = useState('documents');
  const [databaseData, setDatabaseData] = useState({ columns: [], rows: [], counts: {} });
  const [databaseError, setDatabaseError] = useState('');
  const [databaseLoading, setDatabaseLoading] = useState(false);
  const [currentView, setCurrentView] = useState('overview');
  const [liveProgress, setLiveProgress] = useState({ total: 0, completed: 0, errors: 0 });
  const [notice, setNotice] = useState({ type: '', text: '' });
  const [loading, setLoading] = useState(true);
  const [relationsLoading, setRelationsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
  const [vectorizationJob, setVectorizationJob] = useState(null);
  const [vectorizing, setVectorizing] = useState(false);
  const [chatSessionId, setChatSessionId] = useState(() => window.localStorage.getItem('rag-chat-session') || '');
  const [chatSessions, setChatSessions] = useState([]);
  const [chatSwitchLoading, setChatSwitchLoading] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatHistorySessionId, setChatHistorySessionId] = useState('');
  const [chatHistoryMessages, setChatHistoryMessages] = useState([]);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [typewriterMessageId, setTypewriterMessageId] = useState(null);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);
  const chatHistoryEndRef = useRef(null);
  const documentsPageSize = 20;
  const [documentsPage, setDocumentsPage] = useState(1);
  const [documentsTotal, setDocumentsTotal] = useState(0);
  const [documentsPages, setDocumentsPages] = useState(1);

  const loadData = async (nextFilters = filters, nextPage = documentsPage) => {
    setLoading(true);
    try {
      const [nextStats, nextDocuments, nextRelations] = await Promise.all([
        api.stats(), api.documents(nextFilters, nextPage, documentsPageSize), api.relations()
      ]);
      setStats(nextStats);
      setDocuments(nextDocuments.documents);
      setDocumentsPage(nextDocuments.page || nextPage);
      setDocumentsTotal(nextDocuments.total ?? nextDocuments.documents.length);
      setDocumentsPages(nextDocuments.pages || 1);
      setRelations(nextRelations.relations);
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);
  useEffect(() => {
    if (currentView !== 'relations') return undefined;
    let mounted = true;
    setRelationsLoading(true);
    api.relations(null, 100)
      .then((result) => { if (mounted) setRelations(result.relations); })
      .catch((error) => { if (mounted) setNotice({ type: 'error', text: error.message }); })
      .finally(() => { if (mounted) setRelationsLoading(false); });
    return () => { mounted = false; };
  }, [currentView]);
  useEffect(() => {
    let mounted = true;
    const loadChat = async () => {
      try {
        try {
          const sync = await api.syncVectorStore('rag');
          if (!mounted) return;
          if (sync.jobId) {
            setVectorizationJob(sync);
            setVectorizing(true);
          } else {
            setVectorizationJob(null);
            setVectorizing(false);
          }
        } catch (syncError) {
          // L'indicizzazione richiede OpenAI; la ricerca documentale resta disponibile localmente.
          if (mounted && !syncError.message.includes('OPENAI_API_KEY')) setNotice({ type: 'error', text: syncError.message });
        }
        const sessionResult = await api.chatSessions();
        let sessions = sessionResult.sessions || [];
        let sessionId = chatSessionId;
        if (!sessionId || !sessions.some((session) => session.id === sessionId)) {
          sessionId = sessions[0]?.id || '';
        }
        if (sessionId) window.localStorage.setItem('rag-chat-session', sessionId);
        else window.localStorage.removeItem('rag-chat-session');
        if (mounted) {
          setChatSessions(sessions);
          setChatSessionId(sessionId);
        }
        const result = sessionId ? await api.chatMessages(sessionId) : { messages: [] };
        if (mounted) {
          setTypewriterMessageId(null);
          setChatMessages(result.messages || []);
        }
      } catch (error) {
        if (!mounted) return;
        window.localStorage.removeItem('rag-chat-session');
        setChatSessionId('');
        setChatMessages([]);
        setNotice({ type: 'error', text: error.message });
      }
    };
    loadChat();
    return () => { mounted = false; };
  }, [currentView]);

  const createNewChat = async () => {
    if (chatSwitchLoading) return;
    setChatSwitchLoading(true);
    try {
      const session = await api.createChatSession();
      setChatSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setChatSessionId(session.id);
      window.localStorage.setItem('rag-chat-session', session.id);
      setTypewriterMessageId(null);
      setChatMessages([]);
      setChatInput('');
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setChatSwitchLoading(false);
    }
  };

  const openChatHistory = async () => {
    setChatHistoryOpen(true);
    setChatHistoryLoading(true);
    try {
      const result = await api.chatSessions();
      const sessions = result.sessions || [];
      setChatSessions(sessions);
      const selectedId = chatSessionId && sessions.some((session) => session.id === chatSessionId) ? chatSessionId : sessions[0]?.id || '';
      setChatHistorySessionId(selectedId);
      if (selectedId) {
        const history = await api.chatMessages(selectedId);
        setChatHistoryMessages(history.messages || []);
      } else {
        setChatHistoryMessages([]);
      }
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setChatHistoryLoading(false);
    }
  };

  const selectHistorySession = async (sessionId) => {
    if (!sessionId || sessionId === chatHistorySessionId || chatHistoryLoading) return;
    setChatHistorySessionId(sessionId);
    setChatHistoryLoading(true);
    try {
      const history = await api.chatMessages(sessionId);
      setChatHistoryMessages(history.messages || []);
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setChatHistoryLoading(false);
    }
  };
  useEffect(() => {
    if (currentView !== 'workspace') return;
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatMessages, chatLoading, currentView]);
  useEffect(() => {
    if (!chatHistoryOpen) return;
    chatHistoryEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chatHistoryMessages, chatHistoryOpen]);
  useEffect(() => {
    if (!vectorizationJob?.jobId || ['completed', 'error'].includes(vectorizationJob.status)) return undefined;
    let mounted = true;
    const poll = async () => {
      try {
        const result = await api.vectorizationJob('rag', vectorizationJob.jobId);
        if (!mounted) return;
        setVectorizationJob(result);
        if (['completed', 'error'].includes(result.status)) setVectorizing(false);
      } catch (error) {
        if (!mounted) return;
        setVectorizing(false);
        setNotice({ type: 'error', text: error.message });
      }
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [vectorizationJob?.jobId, vectorizationJob?.status]);
  useEffect(() => {
    const persistentQueue = queue.map(({ file, result, ...item }) => item);
    window.localStorage.setItem(queueStorageKey, JSON.stringify(persistentQueue));
  }, [queue]);
  useEffect(() => {
    if (folderName) window.localStorage.setItem('rag-extraction-folder', folderName);
    else window.localStorage.removeItem('rag-extraction-folder');
  }, [folderName]);

  const relationForDocument = useMemo(() => {
    if (!selectedDocument) return [];
    return relations.filter((relation) => relation.documentAId === selectedDocument.id || relation.documentBId === selectedDocument.id);
  }, [relations, selectedDocument]);

  const localCompleted = queue.filter((item) => item.status === 'completed' || item.status === 'error').length;
  const localErrors = queue.filter((item) => item.status === 'error').length;
  const queueTotal = liveProgress.total || queue.length;
  const queueCompleted = liveProgress.total ? liveProgress.completed + liveProgress.errors : localCompleted;
  const queueErrors = liveProgress.total ? liveProgress.errors : localErrors;
  const queueProgress = queueTotal ? Math.round((queueCompleted / queueTotal) * 100) : 0;
  const currentExtraction = queue.find((item) => item.status === 'processing');

  const loadDatabaseTable = async (table, accessToken = databaseToken) => {
    setDatabaseLoading(true);
    try {
      setDatabaseData(await api.databaseTable(table, accessToken));
      setDatabaseError('');
    } catch (error) {
      setDatabaseError(error.message);
    } finally {
      setDatabaseLoading(false);
    }
  };

  const handleDatabaseLogin = async (event) => {
    event.preventDefault();
    try {
      const result = await api.databaseAccess(databaseCredentials);
      setDatabaseToken(result.accessToken);
      setDatabaseAccess(true);
      setDatabaseError('');
      await loadDatabaseTable('documents', result.accessToken);
    } catch (error) {
      setDatabaseError(error.message);
    }
  };

  const handleFilter = (event) => {
    event.preventDefault();
    setDocumentsPage(1);
    loadData(filters, 1);
  };

  const changeDocumentsPage = (nextPage) => {
    if (nextPage < 1 || nextPage > documentsPages || nextPage === documentsPage) return;
    loadData(filters, nextPage);
  };

  const runSemanticSearch = async (event) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    setSearchLoading(true);
    setSearchSubmitted(true);
    setSearchResults([]);
    try {
      const result = await api.semanticSearch(query);
      setSearchResults(result.results || []);
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSearchInput = (event) => {
    const value = event.target.value;
    setSearchQuery(value);
    if (!value.trim()) {
      setSearchResults([]);
      setSearchSubmitted(false);
    }
  };

  const sendChatMessage = async (event) => {
    event.preventDefault();
    const content = chatInput.trim();
    if (!content || chatLoading || vectorizing) return;
    const optimisticMessageId = `pending-${Date.now()}`;
    setChatLoading(true);
    setChatInput('');
    setChatMessages((current) => [...current, { id: optimisticMessageId, role: 'user', content, createdAt: new Date().toISOString() }]);
    try {
      let sessionId = chatSessionId;
      if (!sessionId) {
        const session = await api.createChatSession();
        sessionId = session.id;
        setChatSessionId(sessionId);
        window.localStorage.setItem('rag-chat-session', sessionId);
      }
      const result = await api.sendChatMessage(sessionId, content);
      const assistantMessage = result.messages?.find((message) => message.role === 'assistant');
      setTypewriterMessageId(assistantMessage?.id || null);
      setChatMessages((current) => [...current.filter((message) => message.id !== optimisticMessageId), ...(result.messages?.filter((message) => message.role === 'user') || [{ id: optimisticMessageId, role: 'user', content }]), ...(assistantMessage ? [assistantMessage] : [])]);
      const sessions = await api.chatSessions();
      setChatSessions(sessions.sessions || []);
    } catch (error) {
      setChatInput(content);
      setNotice({ type: 'error', text: error.message });
    } finally {
      setChatLoading(false);
    }
  };

  const handleFolder = (event) => {
    const files = Array.from(event.target.files || []);
    const supported = files.filter((file) => supportedExtensions.some((extension) => file.name.toLowerCase().endsWith(extension)));
    const skipped = files.length - supported.length;
    setFolderName(supported[0]?.webkitRelativePath?.split('/')[0] || (supported.length ? 'Cartella selezionata' : ''));
    setQueue(supported.map((file, index) => {
      const relativePath = file.webkitRelativePath || file.name;
      const previous = queue.find((item) => item.relativePath === relativePath);
      const sameFile = previous && previous.fileSize === file.size && previous.lastModified === file.lastModified;
      const canResume = sameFile && previous.status !== 'error';
      return {
        id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        relativePath,
        absolutePath: file.path || file.absolutePath || '',
        status: sameFile && previous.status === 'completed' ? 'completed' : 'waiting',
        batchId: canResume ? previous.batchId || '' : '',
        jobId: canResume ? previous.jobId || null : null,
        jsonFileName: sameFile ? previous.jsonFileName || '' : '',
        result: null,
        error: ''
      };
    }));
    const completed = supported.filter((file) => {
      const previous = queue.find((item) => item.relativePath === (file.webkitRelativePath || file.name));
      return previous?.fileSize === file.size && previous?.lastModified === file.lastModified && previous.status === 'completed';
    }).length;
    setLiveProgress({ total: supported.length, completed, errors: 0 });
    if (skipped > 0) setNotice({ type: 'success', text: `${skipped} file non supportati ignorati. Sono stati messi in coda solo i formati OCR compatibili.` });
  };

  const updateQueueItem = (id, changes) => {
    setQueue((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  };

  const pollBatch = async (batchId) => {
    while (true) {
      const status = await api.extractQueue(batchId);
      const counts = status.counts || {};
      setLiveProgress({ total: status.jobs.length, completed: counts.completed || 0, errors: counts.error || 0 });
      setStats(await api.stats());
      setQueue((current) => current.map((item) => {
        const job = status.jobs.find((candidate) => candidate.id === item.jobId || candidate.relativePath === item.relativePath);
        return job ? { ...item, batchId, jobId: job.id, status: job.status, error: job.error || '', jsonFileName: job.jsonFileName || item.jsonFileName } : item;
      }));
      const pending = status.jobs.some((job) => job.status === 'waiting' || job.status === 'processing');
      if (!pending) {
        await loadData();
        return status;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
  };

  useEffect(() => {
    const persistedBatchId = queue.find((item) => item.batchId)?.batchId;
    const hasPendingJobs = queue.some((item) => item.batchId === persistedBatchId && (item.status === 'waiting' || item.status === 'processing'));
    if (!persistedBatchId || !hasPendingJobs) return;
    setExtracting(true);
    pollBatch(persistedBatchId)
      .catch((error) => setNotice({ type: 'error', text: error.message }))
      .finally(() => setExtracting(false));
  }, []);

  const startExtraction = async () => {
    if (!queue.length || extracting) return;
    const existingBatchId = queue.find((item) => item.batchId && (item.status === 'waiting' || item.status === 'processing'))?.batchId;
    setExtracting(true);
    try {
      if (existingBatchId) {
        setNotice({ type: 'success', text: 'Ripresa della coda server in corso.' });
        await pollBatch(existingBatchId);
      } else {
        const pending = queue.filter((item) => item.status !== 'completed');
        if (pending.some((item) => !item.file)) {
          setNotice({ type: 'error', text: 'Ricollega la cartella per reinviare i file ancora non caricati.' });
          return;
        }
        setNotice({ type: 'success', text: `Caricamento della coda: ${pending.length} file. L’elaborazione partirà sul server uno alla volta.` });
        const batch = await api.extractBatch(pending);
        setQueue((current) => current.map((item) => {
          const job = batch.jobs.find((candidate) => candidate.relativePath === item.relativePath);
          return job ? { ...item, batchId: batch.batchId, jobId: job.id, status: job.status, error: '' } : item;
        }));
        await pollBatch(batch.batchId);
      }
      setNotice({ type: 'success', text: 'Coda completata. I JSON sono stati salvati e importati automaticamente nel database.' });
    } finally {
      setExtracting(false);
    }
  };

  const downloadJson = (item) => {
    let url;
    if (item.result?.extraction) {
      const blob = new Blob([JSON.stringify(item.result.extraction, null, 2)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
    } else if (item.jsonFileName) {
      url = `/api/extractions/${encodeURIComponent(item.jsonFileName)}`;
    } else return;
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = item.jsonFileName || item.result?.jsonFileName || `${item.fileName}.json`;
    anchor.click();
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  };

  const openDocument = async (id) => {
    try {
      const [document, documentRelations] = await Promise.all([api.document(id), api.relations(id, 100)]);
      setSelectedDocument(document);
      setRelations(documentRelations.relations);
      setCurrentView('document');
    }
    catch (error) { setNotice({ type: 'error', text: error.message }); }
  };

  const closeDocument = () => {
    setSelectedDocument(null);
    setCurrentView('overview');
  };

  const rebuild = async () => {
    try {
      const result = await api.rebuildRelations();
      setNotice({ type: 'success', text: `${result.relations} relazioni ricostruite.` });
      await loadData();
    } catch (error) { setNotice({ type: 'error', text: error.message }); }
  };

  const clearHistory = async () => {
    if (!window.confirm('Vuoi cancellare tutto lo storico? Verranno eliminati documenti, pagine, entità, relazioni, JSON generati e file temporanei.')) return;
    try {
      const result = await api.clearHistory(databaseToken);
      setQueue([]);
      setFolderName('');
      setLiveProgress({ total: 0, completed: 0, errors: 0 });
      setSelectedDocument(null);
      setDocumentsPage(1);
      await loadData({ search: '' }, 1);
      if (databaseAccess) await loadDatabaseTable(databaseTable);
      setNotice({ type: 'success', text: `Storico cancellato: ${result.deleted.documents} documenti, ${result.deleted.pages} pagine e ${result.deleted.relations} relazioni rimossi.` });
    } catch (error) {
      setNotice({ type: 'error', text: error.message });
    }
  };

  const chatPanel = <aside id="chat-page" className="assistant-panel" aria-label="Assistente RAG">
    <section className="panel chat-shell">
      <div className="chat-header"><div><p className="eyebrow">RAG ASSISTANT · CORPUS OCR</p><h2>Assistente RAG</h2><p>Conversazione collegata ai documenti e alle pagine indicizzate.</p></div><div className="chat-header-actions"><button className="chat-history-button" onClick={openChatHistory} aria-label="Apri storico conversazioni">☰</button><button className="new-chat-button" onClick={createNewChat} disabled={chatSwitchLoading} aria-label="Nuova chat">+</button></div></div>
      <div className="chat-messages" aria-live="polite">{chatMessages.length === 0 ? <div className="chat-welcome"><button className="empty-new-chat" onClick={createNewChat} disabled={chatSwitchLoading} aria-label="Inizia una nuova chat">+</button><h3>Interroga il corpus</h3><p>Cerca documenti, pagine e relazioni con il contesto RAG indicizzato.</p><div className="chat-suggestions"><button onClick={() => setChatInput('Cerca Italia nel corpus')}>Cerca “Italia”</button><button onClick={() => setChatInput('Quali documenti parlano di assemblea?')}>Cerca documenti</button><button onClick={() => setChatInput('Mostrami le pagine rilevanti')}>Pagine rilevanti</button></div></div> : chatMessages.map((message) => <article className={`chat-message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}><div className="message-avatar">{message.role === 'user' ? 'Tu' : 'R'}</div><div className="message-bubble"><span className="message-role">{message.role === 'user' ? 'Tu' : 'Assistente RAG'}</span>{message.role === 'assistant' && message.id === typewriterMessageId ? <TypewriterMessage content={message.content} /> : <MarkdownMessage content={message.content} />}</div></article>)}{chatLoading && <article className="chat-message assistant-message thinking-message"><div className="message-avatar">R</div><div className="message-bubble thinking-bubble" role="status" aria-label="L’assistente RAG sta elaborando"><span className="thinking-label">Elaborazione RAG</span><span className="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span></div></article>}<div ref={chatEndRef} aria-hidden="true" /></div>
      <form className="chat-composer" onSubmit={sendChatMessage}><textarea value={chatInput} disabled={vectorizing} onChange={(event) => setChatInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} placeholder={vectorizing ? 'Indicizzazione del database…' : 'Interroga il corpus RAG…'} aria-label="Messaggio per l’assistente RAG" rows="1" /><button className="chat-send" disabled={!chatInput.trim() || chatLoading || vectorizing} aria-label="Invia messaggio">↑</button><small>Invio per spedire · Shift + Invio per andare a capo</small></form>
    </section>
    {chatHistoryOpen && <div className="chat-history-backdrop" onClick={() => setChatHistoryOpen(false)}><section className="chat-history-dialog" role="dialog" aria-modal="true" aria-label="Storico conversazioni" onClick={(event) => event.stopPropagation()}>
      <header className="chat-history-dialog-header"><div><p className="eyebrow">RAG · STORICO</p><h3>Conversazioni</h3></div><button className="chat-history-close" onClick={() => setChatHistoryOpen(false)} aria-label="Chiudi storico">×</button></header>
      <div className="chat-history-layout">
        <aside className="chat-history-list" aria-label="Elenco conversazioni">
          {chatSessions.length === 0 ? <div className="chat-history-empty">Nessuna chat salvata.</div> : chatSessions.map((session) => <button className={`chat-history-item ${session.id === chatHistorySessionId ? 'active' : ''}`} key={session.id} onClick={() => selectHistorySession(session.id)}><strong>{session.firstMessage || session.title || 'Nuova conversazione'}</strong><small>{session.messageCount || 0} messaggi</small></button>)}
        </aside>
        <section className="chat-history-preview" aria-label="Messaggi della conversazione selezionata">
          <div className="chat-history-preview-head"><span>{chatSessions.find((session) => session.id === chatHistorySessionId)?.firstMessage || 'Seleziona una conversazione'}</span>{chatHistoryLoading && <small>Caricamento…</small>}</div>
          <div className="chat-history-messages">{chatHistoryLoading ? <div className="chat-history-empty">Recupero dello storico dal database…</div> : chatHistoryMessages.length === 0 ? <div className="chat-history-empty">Nessun messaggio in questa conversazione.</div> : chatHistoryMessages.map((message) => <article className={`chat-message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`} key={message.id}><div className="message-avatar">{message.role === 'user' ? 'Tu' : 'R'}</div><div className="message-bubble"><span className="message-role">{message.role === 'user' ? 'Tu' : 'Assistente RAG'}</span><MarkdownMessage content={message.content} /></div></article>)}<div ref={chatHistoryEndRef} aria-hidden="true" /></div>
        </section>
      </div>
    </section></div>}
  </aside>;

  return <div className={`app-shell ${currentView === 'workspace' ? 'workspace-active' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">R</div><div><strong>RAG</strong><span>Workspace documentale</span></div></div>
      <div className="sidebar-label">Workspace</div>
      <nav><a className={currentView === 'overview' ? 'active' : ''} href="#overview" onClick={() => { setSelectedDocument(null); setCurrentView('overview'); }}><span>◈</span>Panoramica</a><a className={currentView === 'workspace' ? 'active' : ''} href="#workspace-page" onClick={() => { setSelectedDocument(null); setCurrentView('workspace'); }}><span>⌕</span>Ricerca</a><a className={currentView === 'extraction' ? 'active' : ''} href="#extraction-page" onClick={() => { setSelectedDocument(null); setCurrentView('extraction'); }}><span>⇧</span>Estrazione</a><a className={currentView === 'relations' ? 'active' : ''} href="#relations-page" onClick={() => { setSelectedDocument(null); setCurrentView('relations'); }}><span>⌘</span>Relazioni</a><a className={currentView === 'database' ? 'active' : ''} href="#database" onClick={() => { setSelectedDocument(null); setCurrentView('database'); }}><span>▥</span>Database</a></nav>
      <div className="sidebar-foot"><span className="status-dot"></span><div><strong>SQLite locale</strong><small>Database operativo</small></div></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="topbar-title"><p className="eyebrow">RAG WORKSPACE / {currentView === 'workspace' ? 'QUERY' : currentView.toUpperCase()}</p><h1>{currentView === 'workspace' ? 'Interroga il corpus' : currentView === 'extraction' ? 'Estrazione documentale' : currentView === 'database' ? 'Database' : currentView === 'relations' ? 'Correlazioni' : currentView === 'document' ? 'Documento' : 'Panoramica'}</h1></div><div className="topbar-tools"><div className="extraction-status"><span className="status-caption">ESTRAZIONE</span><div className="mini-progress"><i style={{ width: queueProgress + '%' }} /></div><span className="mini-progress-value">{queueTotal ? queueProgress + '%' : '—'}</span></div><button className="topbar-utility-button" onClick={() => { setCurrentView('extraction'); window.setTimeout(() => document.getElementById('folder-input')?.click(), 0); }}><span>⇧</span> Estrai</button><button className="topbar-utility-button" onClick={() => setCurrentView('database')}><span>▥</span> Database</button></div></header>
      {notice.text && <div className={`notice ${notice.type}`}>{notice.text}<button onClick={() => setNotice({ type: '', text: '' })}>×</button></div>}

      {currentView === 'overview' && <div className="page-view">
      <section id="overview" className="stats-grid">
        <StatCard label="Documenti" value={stats.documents} detail="file indicizzati" accent="orange" />
        <StatCard label="Pagine OCR" value={stats.pages} detail="con indice pagina" />
        <StatCard label="Testo indicizzato" value={stats.pages} detail="pagine usate per le relazioni" />
        <StatCard label="Relazioni" value={stats.relations} detail="legami deterministici" accent="violet" />
      </section>


      <section id="documents" className="panel content-panel"><div className="section-heading"><div><p className="eyebrow">CORPUS</p><h2>Documenti indicizzati</h2></div><span className="result-count">{documentsTotal} documenti</span></div>
        <form className="filters" onSubmit={handleFilter}><label><span>⌕</span><input value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} placeholder="Cerca file, titolo o testo" /></label><button className="filter-button">Filtra</button></form>
        <div className="table-wrap"><table><thead><tr><th>Documento</th><th>Estratto</th><th>Entità</th><th>Importato</th><th></th></tr></thead><tbody>{loading ? <tr><td colSpan="5" className="empty-state">Caricamento…</td></tr> : documents.length === 0 ? <tr><td colSpan="5" className="empty-state">Nessun documento. Seleziona una cartella PDF e avvia l’estrazione.</td></tr> : documents.map((document) => <tr key={document.id} onClick={() => openDocument(document.id)}><td><div className="doc-cell"><span className="file-icon">PDF</span><div><strong>{document.title || document.fileName}</strong><small>{document.title ? document.fileName : document.sourceKey}</small></div></div></td><td><span className="page-count">{document.pageCount} pagine</span></td><td><span className="entity-count">{document.entityCount} entità</span></td><td className="date-cell">{new Date(document.importedAt).toLocaleDateString('it-IT')}</td><td><button className="row-action" aria-label="Apri documento">→</button></td></tr>)}</tbody></table></div>
        <div className="pagination-bar"><span>{documentsTotal ? `Pagina ${documentsPage} di ${documentsPages}` : 'Nessun documento'}</span><div className="pagination-controls"><button type="button" disabled={documentsPage <= 1} onClick={() => changeDocumentsPage(documentsPage - 1)}>←</button>{Array.from({ length: documentsPages }, (_, index) => index + 1).slice(Math.max(0, documentsPage - 3), Math.min(documentsPages, documentsPage + 2)).map((page) => <button type="button" key={page} className={page === documentsPage ? 'active' : ''} onClick={() => changeDocumentsPage(page)}>{page}</button>)}<button type="button" disabled={documentsPage >= documentsPages} onClick={() => changeDocumentsPage(documentsPage + 1)}>→</button></div></div>
      </section>

      </div>}

      {currentView === 'extraction' && <div id="extraction-page" className="page-view extraction-page">
        <section id="extract" className="extract-panel panel">
          <div className="section-heading"><div><p className="eyebrow">OCR DETERMINISTICO</p><h2>Estrai una cartella</h2></div><span className="code-badge">PYTHON · NO AI</span></div>
          <p className="panel-intro">Seleziona una cartella: i file vengono messi in coda ed elaborati uno alla volta. Il server usa uno staging su disco, carica in memoria solo il PDF attivo e libera le risorse prima di passare al successivo.</p>
          <div className="folder-toolbar"><div className="folder-picker"><input id="folder-input" type="file" multiple webkitdirectory="" directory="" onChange={handleFolder} /><label htmlFor="folder-input"><span className="folder-icon">▧</span><div><strong>{folderName || 'Collega una cartella'}</strong><small>Solo file PDF · testo nativo o scansioni</small></div><span className="choose-folder">Scegli</span></label></div><button className="primary-button extract-button" disabled={!queue.length || extracting} onClick={startExtraction}>{extracting ? 'Estrazione in corso…' : `Estrai ${queue.length ? `(${queue.length})` : 'file'}`} <span>→</span></button></div>
          <div className="queue-header"><strong>Avanzamento coda</strong><span>{queueTotal ? `${queueCompleted} / ${queueTotal} processati · ${queueErrors} errori` : 'Nessun file in coda'}</span></div><div className="progress-meta"><span>{currentExtraction ? `In elaborazione: ${currentExtraction.fileName || currentExtraction.file?.name}` : !queueTotal ? 'Seleziona una cartella PDF per iniziare' : queueCompleted === queueTotal ? 'Elaborazione completata' : 'Coda pronta per l’avvio'}</span><strong>{queueTotal ? `${queueProgress}%` : '0%'}</strong></div><div className="progress-track"><div className={`progress-value ${currentExtraction ? 'indeterminate' : ''}`} style={{ width: `${currentExtraction ? 100 : queueProgress}%` }} /></div>
          {queue.length > 0 && <div className="extraction-queue">{queue.map((item, index) => <div className="queue-row" key={item.id}><span className={`queue-number ${item.status}`}>{item.status === 'completed' ? '✓' : item.status === 'error' ? '!' : String(index + 1).padStart(2, '0')}</span><div className="queue-file"><strong>{item.fileName || item.file?.name}</strong><small>{item.relativePath} · {((item.fileSize || item.file?.size || 0) / 1024).toFixed(0)} KB</small></div><span className={`queue-status ${item.status}`}>{item.status === 'waiting' ? 'In coda' : item.status === 'processing' ? 'Estrazione…' : item.status === 'completed' ? 'JSON + DB' : 'Errore'}</span>{item.status === 'completed' ? <button className="download-button" onClick={() => downloadJson(item)}>JSON ↓</button> : <span className="queue-error" title={item.error}>{item.error || ''}</span>}</div>)}</div>}
        </section>
      </div>}

      {currentView === 'relations' && <div id="relations-page" className="page-view relations-page">
        <section className="stats-grid relations-stats">
          <StatCard label="Relazioni totali" value={stats.relations} detail="presenti in SQLite" accent="violet" />
          <StatCard label="Documenti" value={stats.documents} detail="confrontati nel corpus" />
          <StatCard label="Pagine" value={stats.pages} detail="testo completo indicizzato" />
          <StatCard label="Metodo" value="TESTO" detail="nessuna AI / nessun tag location-year" />
        </section>
        <section className="panel content-panel method-panel">
          <div className="section-heading"><div><p className="eyebrow">COME NASCE UN LEGAME</p><h2>Metodo di relazione deterministico</h2></div><span className="code-badge">PAGINA · TESTO</span></div>
          <p className="panel-intro">Le relazioni non vengono dedotte da un modello AI: vengono calcolate sul testo OCR completo salvato per ogni pagina.</p>
          <div className="method-grid">
            <article className="method-card"><span className="method-number">01</span><h3>Testo per pagina</h3><p>Ogni PDF viene diviso in pagine. Per ogni pagina conserviamo numero pagina, testo estratto e JSON strutturato.</p></article>
            <article className="method-card"><span className="method-number">02</span><h3>Normalizzazione</h3><p>Il testo viene portato in minuscolo, normalizzato negli accenti e diviso in parole. Rimuoviamo stop-word e token numerici isolati.</p></article>
            <article className="method-card"><span className="method-number">03</span><h3>Confronto</h3><p>Per ogni documento costruiamo una mappa parola → pagine. Due documenti diventano collegati quando condividono almeno due parole significative.</p></article>
            <article className="method-card"><span className="method-number">04</span><h3>Prova del legame</h3><p>Ogni parola comune conserva le pagine A e B. Il punteggio cresce con il numero di parole condivise: parole comuni + min(parole comuni, 10) / 10.</p></article>
          </div>
          <div className="method-note"><strong>Importante:</strong> location e year non sono necessari per creare i collegamenti. Il database conserva invece il testo integrale e l’indice delle pagine per poter verificare ogni relazione.</div>
        </section>
        <section className="panel content-panel">
          <div className="section-heading"><div><p className="eyebrow">ESEMPI ORDINATI PER PUNTEGGIO</p><h2>Relazioni calcolate</h2></div><span className="result-count">{relations.length} esempi caricati</span></div>
          {relationsLoading ? <div className="empty-state">Caricamento relazioni…</div> : <div className="relations-list">{relations.length === 0 ? <div className="empty-state">Nessuna relazione disponibile.</div> : relations.map((relation) => <div className="relation-row" key={relation.id}><div className="relation-doc"><span className="node-dot orange-dot"></span><strong>{relation.documentAFileName}</strong></div><div className="relation-line"><span className="score">{relation.score.toFixed(2)}</span><span className="line"></span><span className="shared-label">{relation.sharedEntityCount ?? relation.sharedEntities.length} parole comuni</span></div><div className="relation-doc right"><strong>{relation.documentBFileName}</strong><span className="node-dot violet-dot"></span></div><div className="shared-entities">{relation.sharedEntities.map((entity) => <EntityPill key={`${relation.id}-${entity.type}-${entity.value}`} entity={entity} />)}</div></div>)}</div>}
        </section>
      </div>}

      {currentView === 'document' && <div className="page-view document-page">
        {!selectedDocument ? <section className="panel content-panel"><div className="empty-state">Seleziona un documento dalla panoramica.</div></section> : <>
          <section className="panel document-hero">
            <div className="document-hero-main"><span className="file-icon large">PDF</span><div><p className="eyebrow">DOCUMENTO #{selectedDocument.id}</p><h2>{selectedDocument.title || selectedDocument.fileName}</h2><p>{selectedDocument.fileName}</p></div></div>
            <div className="document-hero-actions"><button className="ghost-button" onClick={closeDocument}>← Documenti</button></div>
            <div className="document-meta-grid"><div><span>Path assoluta</span><strong>{selectedDocument.absolutePath || 'Non disponibile dal browser'}</strong></div><div><span>Source key</span><strong>{selectedDocument.sourceKey}</strong></div><div><span>Checksum</span><strong>{selectedDocument.checksum || '—'}</strong></div><div><span>Importato</span><strong>{selectedDocument.importedAt ? new Date(selectedDocument.importedAt).toLocaleString('it-IT') : '—'}</strong></div></div>
          </section>
          <section className="stats-grid detail-stats"><StatCard label="Pagine" value={selectedDocument.pages.length} detail="con indice pagina" accent="orange" /><StatCard label="Entità" value={selectedDocument.entities.length} detail="estratte dal JSON" /><StatCard label="Relazioni" value={relationForDocument.length} detail="relazioni caricate" accent="violet" /><StatCard label="OCR" value="PDF" detail="testo nativo / Tesseract" /></section>
          <section className="panel content-panel extraction-detail-panel"><div className="section-heading"><div><p className="eyebrow">ESTRAZIONE COMPLETA</p><h2>Testo e JSON pagina per pagina</h2></div><span className="result-count">{selectedDocument.pages.length} pagine</span></div><p className="panel-intro">Questa vista mostra il testo integrale associato al numero della pagina. Aprendo il pannello JSON puoi verificare anche la struttura salvata nell’estrazione.</p><div className="detail-pages">{selectedDocument.pages.map((page) => <article className="detail-page-card" key={page.id}><div className="detail-page-header"><div><span>Pagina {page.pageNumber}</span><small>{page.entities.length} entità indicizzate</small></div><span className="page-id">ID {page.id}</span></div><div className="detail-page-text">{page.text || 'Nessun testo OCR disponibile.'}</div>{page.entities.length > 0 && <div className="pill-list">{page.entities.map((entity) => <EntityPill key={`${page.id}-${entity.type}-${entity.value}`} entity={entity} />)}</div>}<details className="page-json"><summary>Mostra JSON strutturato della pagina</summary><pre>{JSON.stringify(page.extracted, null, 2)}</pre></details></article>)}</div></section>
          {relationForDocument.length > 0 && <section className="panel content-panel"><div className="section-heading"><div><p className="eyebrow">COLLEGAMENTI</p><h2>Documenti collegati</h2></div><span className="result-count">{relationForDocument.length}</span></div><div className="detail-relations">{relationForDocument.map((relation) => <div className="drawer-relation" key={relation.id}><strong>{relation.documentAId === selectedDocument.id ? relation.documentBFileName : relation.documentAFileName}</strong><span>{relation.sharedEntityCount ?? relation.sharedEntities.length} parole comuni</span></div>)}</div></section>}
        </>}
      </div>}

      {currentView === 'workspace' && <div id="workspace-page" className="page-view workspace-page">
        <section id="search-page" className="workspace-search">
        <section className="panel search-hero">
          <div className="section-heading"><div><p className="eyebrow">TESTO COMPLETO · PAGINE OCR</p><h2>Cerca nei documenti</h2></div></div>
          <p className="panel-intro">Scrivi una parola, una frase o più termini. Il sistema restituisce i file che contengono il testo, ordinandoli per corrispondenza e mostrando le pagine coinvolte.</p>
          <form className="semantic-search-form" onSubmit={runSemanticSearch}><label><span>⌕</span><input autoFocus value={searchQuery} onChange={handleSearchInput} placeholder="es. Italia, assemblea, 1997…" aria-label="Testo da cercare" /></label><button className="primary-button" disabled={!searchQuery.trim() || searchLoading}>{searchLoading ? 'Cerco…' : 'Cerca'} <span>→</span></button></form>
        </section>
        <section className="panel content-panel search-results-panel">
          {!searchSubmitted ? <div className="empty-state search-empty"><span className="search-empty-icon">⌕</span><strong>Cerca nel corpus OCR</strong><span>Il risultato includerà nome file, pagine e anteprima del testo trovato.</span></div> : searchLoading ? <div className="empty-state">Ricerca in corso…</div> : searchResults.length === 0 ? <div className="empty-state">Nessun risultato per “{searchQuery}”.</div> : <div className="search-results-list">{searchResults.map((result) => <article className="search-result-card" key={result.id} onClick={() => openDocument(result.id)}><div className="search-result-head"><div className="doc-cell"><span className="file-icon">PDF</span><div><strong>{result.title || result.fileName}</strong></div></div><span className="relevance-score">{result.score} punti</span></div><div className="search-match-row"><span className="search-match-label">Parole trovate</span><div className="pill-list">{result.matchedTerms.map((term) => <EntityPill key={`${result.id}-${term}`} entity={{ type: 'text', value: term }} />)}</div></div><div className="search-pages">{result.pages.map((page) => <div className="search-page-result" key={page.pageId}><span className="page-document-icon" aria-label={`Pagina ${page.pageNumber}`}>{page.pageNumber}</span><p dangerouslySetInnerHTML={{ __html: highlightSearchText(page.snippet, result.matchedTerms) }} /></div>)}</div></article>)}</div>}
        </section>
        </section>
      </div>}

      {currentView === 'database' && <section id="database" className="panel database-panel database-page">
        <div className="section-heading"><div><p className="eyebrow">SQLITE INSPECTOR</p><h2>Visualizzazione database</h2></div><span className="code-badge">ACCESSO DEMO</span></div>
        {!databaseAccess ? <form className="database-login" onSubmit={handleDatabaseLogin}><div className="login-copy"><strong>Accedi al pannello dati</strong><span>Console di sola visualizzazione per controllare le tabelle generate dall’estrazione.</span></div><div className="login-fields"><input aria-label="Username database" placeholder="Username" value={databaseCredentials.username} onChange={(event) => setDatabaseCredentials({ ...databaseCredentials, username: event.target.value })} /><input aria-label="Password database" type="password" placeholder="Password" value={databaseCredentials.password} onChange={(event) => setDatabaseCredentials({ ...databaseCredentials, password: event.target.value })} /><button className="filter-button">Accedi</button></div><small className="demo-credentials">Credenziali fittizie: <code>admin</code> / <code>rag-demo</code></small></form> : <div className="database-view"><div className="database-toolbar"><div className="database-tabs">{['documents', 'pages', 'entities', 'relations', 'ai_requests', 'ai_vectors', 'ai_vectorization_jobs', 'ai_manifests', 'source_manifest'].map((table) => <button key={table} className={databaseTable === table ? 'active' : ''} onClick={() => { setDatabaseTable(table); loadDatabaseTable(table); }}>{table}</button>)}</div><button className="logout-button" onClick={() => { setDatabaseAccess(false); setDatabaseToken(''); }}>Esci</button></div><div className="database-counts">{Object.entries(databaseData.counts).map(([table, count]) => <div key={table}><span>{table}</span><strong>{count}</strong></div>)}</div><div className="database-table-wrap">{databaseLoading ? <div className="empty-state">Caricamento dati…</div> : databaseData.rows.length === 0 ? <div className="empty-state">Nessun record nella tabella.</div> : <table className="database-table"><thead><tr>{databaseData.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{databaseData.rows.map((row, index) => <tr key={row.id || index}>{databaseData.columns.map((column) => <td key={column} title={String(row[column] ?? '')}>{row[column] == null ? '—' : typeof row[column] === 'object' ? JSON.stringify(row[column]) : String(row[column])}</td>)}</tr>)}</tbody></table>}</div></div>}
        {databaseError && <div className="database-error">{databaseError}</div>}
        {databaseAccess && <div className="database-danger-zone"><div><strong>Gestione storico</strong><span>Cancella definitivamente database, JSON generati e file temporanei.</span></div><button className="danger-button" onClick={clearHistory}>⌫ Pulisci storico</button></div>}
      </section>}

      <section className="activity-console" aria-label="Console attività"><div className="console-heading"><span>CONSOLE ATTIVITÀ</span><span className="live-indicator"><i></i> LIVE</span></div><div className="console-events"><span><b>SYNC</b> indice locale aggiornato</span><span><b>OCR</b> {queueTotal ? `${queueCompleted}/${queueTotal} file processati` : 'in attesa di una cartella'}</span><span><b>RAG</b> {vectorizing ? 'indicizzazione in corso' : 'servizio pronto'}</span></div></section>
    </main>

    {chatPanel}

    {selectedDocument && currentView !== 'document' && <div className="drawer-backdrop" onClick={() => setSelectedDocument(null)}><aside className="drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-header"><div><p className="eyebrow">DOCUMENTO #{selectedDocument.id}</p><h2>{selectedDocument.title || selectedDocument.fileName}</h2><small>{selectedDocument.fileName}</small></div><button className="close-button" onClick={() => setSelectedDocument(null)}>×</button></div><div className="drawer-content"><div className="detail-section"><h3>Entità indicizzate</h3><div className="pill-list">{selectedDocument.entities.map((entity) => <EntityPill key={`${entity.type}-${entity.value}`} entity={entity} />)}</div></div><div className="detail-section"><h3>Pagine ({selectedDocument.pages.length})</h3>{selectedDocument.pages.map((page) => <article className="page-card" key={page.id}><div className="page-header"><span>Pagina {page.pageNumber}</span><small>{page.entities.length} entità</small></div><p>{page.text || 'Nessun testo OCR disponibile.'}</p>{page.entities.length > 0 && <div className="pill-list">{page.entities.map((entity) => <EntityPill key={`${page.id}-${entity.type}-${entity.value}`} entity={entity} />)}</div>}</article>)}</div>{relationForDocument.length > 0 && <div className="detail-section"><h3>Collegato a</h3>{relationForDocument.map((relation) => <div className="drawer-relation" key={relation.id}>{relation.documentAId === selectedDocument.id ? relation.documentBFileName : relation.documentAFileName}<span>{relation.sharedEntityCount ?? relation.sharedEntities.length} parole comuni</span></div>)}</div>}</div></aside></div>}
  </div>;
}

export default App;
