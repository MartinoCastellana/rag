# RAG · Workspace documentale

Base applicativa per trasformare estrazioni OCR deterministiche in un workspace RAG documentale.

## Stack

- React + Vite per l'interfaccia
- Node.js + Express per le API
- SQLite tramite `node:sqlite`
- Integrazione opzionale con OpenAI Responses API e Structured Outputs
- Vector store locale SQLite per embedding già calcolati

## Avvio

Richiede Node.js 22.5 o superiore (il server usa il modulo SQLite integrato `node:sqlite`).

```bash
npm install
npm run dev
```

Apri <http://localhost:5173>.

### Attivare l'API AI

La chiave resta solo nel backend, mai nel client. Avvia il server con:

```bash
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-6-luna \
OPENAI_EMBEDDING_MODEL=text-embedding-3-small \
npm run dev
```

La ricerca documentale (`/api/search`) resta deterministica e locale. L'assistente RAG e la ricerca semantica AI richiedono `OPENAI_API_KEY`: `gpt-6-luna` genera le risposte, mentre `text-embedding-3-small` vettorializza le pagine e la query. Ogni domanda recupera i vettori più simili e invia al modello solo il contesto recuperato.

## Endpoint AI e vector store

### 1. Ingestione di un database vettorializzato

Il backend accetta vettori già calcolati, così il database può essere preparato da un processo esterno. Il campo `metadata` è libero e viene restituito nelle fonti:

```bash
curl -X POST http://localhost:4000/api/ai/vector-store/rag/ingest \
  -H 'Content-Type: application/json' \
  -d '{"embeddingModel":"text-embedding-3-small","documents":[{"id":"page-001","text":"Testo della pagina...","embedding":[0.12,-0.03,0.44],"metadata":{"fileName":"fascicolo.pdf","pageNumber":3,"documentId":12}}]}'
```

Tutti i vettori di una collection devono avere la stessa dimensione. L'endpoint è idempotente su `collection + id`.

### 2. Domanda RAG con JSON strutturato

```bash
curl -X POST http://localhost:4000/api/ai/query \
  -H 'Content-Type: application/json' \
  -d '{"collection":"rag","question":"Quali documenti parlano dell assemblea?","topK":6,"instructions":"Rispondi in modo sintetico e cita sempre le pagine."}'
```

La risposta contiene `structured.message` in Markdown, `structured.request` con la richiesta interpretata, `structured.citations` per le fonti e `telemetry` con provider, modello, token e latenza. Il JSON è vincolato da uno schema strict lato API.

### 3. Sincronizzazione automatica del vector store

```bash
curl -X POST http://localhost:4000/api/ai/vector-store/rag/sync \
  -H 'Content-Type: application/json' \
  -d '{}'
```

La stessa sincronizzazione parte automaticamente all'apertura della chat. Il backend confronta la revisione del `source_manifest` con `ai_manifests`; se il database è cambiato crea un job asincrono che legge le pagine OCR da SQLite, divide le pagine lunghe in chunk, invia gli embedding in batch, salva i vettori e conserva i metadata di documento e pagina. La revisione viene aggiornata da trigger SQLite sulle modifiche a `documents` e `pages` e viene esportata anche in `server/data/vector-manifest.json`. Non c'è un pulsante manuale nel frontend.

Stato job:

```text
GET /api/ai/vector-store/rag/vectorize/:jobId
```

Con `force: false` i chunk già presenti e invariati vengono saltati. Ogni batch di embedding viene tracciato in `ai_requests` con token, modello, latenza ed eventuale errore.

### 4. Chat collegata all'interfaccia

La sezione Assistente RAG gestisce più conversazioni persistenti. Usa `GET /api/chat/sessions` per l'elenco, `POST /api/chat/sessions` per creare una nuova chat e `POST /api/chat/sessions/:sessionId/messages` con `{ "content": "..." }` per inviare messaggi. Salva il messaggio utente, la risposta Markdown e i metadati della richiesta. L'audit completo è consultabile con:

- `GET /api/ai/vector-store/:collection`
- `POST /api/ai/vector-store/:collection/sync`
- `POST /api/ai/vector-store/:collection/vectorize`
- `GET /api/ai/vector-store/:collection/vectorize/:jobId`
- `GET /api/ai/requests?limit=50`
- `GET /api/ai/requests/:requestId`
- `POST /api/ai/query`
- `GET /api/chat/sessions`
- `POST /api/chat/sessions`
- `POST /api/chat/sessions/:sessionId/messages`

## Estrazione da cartella

Dalla sezione **Estrai una cartella** puoi selezionare una directory dal browser. I file supportati vengono messi in coda e inviati sequenzialmente all'estrattore Python. Per ogni file il server:

1. crea un JSON indipendente in `server/data/extractions/`;
2. assegna `pageNumber` a ogni pagina;
3. conserva il testo completo e gli eventuali campi testuali espliciti;
4. importa automaticamente il risultato in SQLite e ricostruisce le relazioni sulla sovrapposizione del testo.

Per i PDF installa le dipendenze Python:

```bash
python3 -m venv server/.venv
server/.venv/bin/python3 -m pip install -r server/python/requirements.txt
```

Se `server/.venv` esiste, il backend lo usa automaticamente per l'estrattore.

Il motore usa il testo nativo del PDF quando disponibile. Se una pagina non contiene testo, la renderizza ad alta risoluzione e la passa a Tesseract con `ita+eng`. Il testo completo resta associato alla pagina; non vengono generate entità automatiche `location` o `year`. Le relazioni usano parole significative condivise tra i testi dei documenti. Serve inoltre Tesseract OCR installato sul sistema, ad esempio su macOS:

```bash
brew install tesseract tesseract-lang
```

La coda frontend accetta attualmente solo file PDF.

L'upload dei PDF usa uno staging su disco senza `LIMIT_FILE_SIZE`, quindi non carica l'intero file nella RAM. Al termine dell'estrazione il JSON viene parsato e scritto automaticamente in SQLite.

## Inspector database

La sezione **Database** offre una visualizzazione demo delle tabelle documentali, del vector store (`ai_vectors`) e dell'audit AI (`ai_requests`), oltre al pulsante per pulire lo storico.

Credenziali fittizie:

```text
username: admin
password: rag-demo
```

Il server API è disponibile su <http://localhost:4000>.

## JSON OCR generato

Il worker genera automaticamente un documento JSON per ogni PDF completato. Ogni documento contiene `pages`, e ogni pagina conserva il proprio numero esplicito.

```json
{
  "documents": [
    {
      "sourceKey": "archivio/cartella/file-001.pdf",
      "fileName": "file-001.pdf",
      "title": "Titolo opzionale",
      "metadata": { "batch": "2026-01" },
      "entities": [
        { "type": "location", "value": "Italia" },
        { "type": "year", "value": "1997" }
      ],
      "pages": [
        {
          "pageNumber": 1,
          "text": "Testo OCR della prima pagina...",
          "entities": [
            { "type": "keyword", "value": "archivio" }
          ],
          "blocks": []
        }
      ]
    }
  ]
}
```

Le entità possono essere dichiarate a livello di documento o pagina. Le entità di pagina conservano anche il riferimento alla pagina nel database; quelle di documento sono valide per tutto il documento.

Il database salva anche `documents.absolute_path` quando il client fornisce la path assoluta. Nei browser standard la selezione cartella espone per sicurezza solo `webkitRelativePath`; la colonna rimane quindi `NULL` in quel caso, mentre client desktop o integrazioni locali possono valorizzarla.

## API principali

- `GET /api/health`
- `GET /api/stats`
- `GET /api/documents?search=&location=&year=`
- `GET /api/documents/:id`
- `GET /api/relations`
- `GET /api/graph`
- `POST /api/extract-file`
- `GET /api/extract-queue`
- `POST /api/database/access`
- `GET /api/database?table=documents`
- `DELETE /api/database/history`
- `POST /api/relations/rebuild`
- `POST /api/ai/vector-store/:collection/ingest`
- `GET /api/ai/vector-store/:collection`
- `POST /api/ai/query`
- `GET /api/ai/requests`

## Struttura

```text
client/              Interfaccia React
server/src/          API, schema SQLite e motore relazioni
server/data/         Database locale generato a runtime
```
