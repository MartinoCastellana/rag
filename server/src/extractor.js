import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingest } from './ingest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const extractionsDirectory = path.resolve(__dirname, '../data/extractions');
export const uploadsDirectory = path.resolve(__dirname, '../data/uploads');
const pythonScript = path.resolve(__dirname, '../python/ocr_extract.py');
const localPython = path.resolve(__dirname, '../.venv/bin/python3');

await fsp.mkdir(extractionsDirectory, { recursive: true });
await fsp.mkdir(uploadsDirectory, { recursive: true });

function safeName(value) {
  return String(value || 'file')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160) || 'file';
}

function runPython(inputPath, sourceKey, fileName) {
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN || (fs.existsSync(localPython) ? localPython : 'python3');
    const child = spawn(python, [pythonScript, '--input', inputPath, '--source-key', sourceKey, '--file-name', fileName], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`Impossibile avviare Python: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `L'estrattore Python ha restituito il codice ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('L\'estrattore Python non ha restituito un JSON valido.'));
      }
    });
  });
}

export function checksumFile(inputPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(inputPath).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

export async function extractAndPersist({ inputPath: providedInputPath, buffer, originalName, relativePath, absolutePath }) {
  const fileName = path.basename(originalName || 'file');
  const sourceKey = String(relativePath || fileName).replaceAll('\\', '/');
  const workDirectory = providedInputPath ? null : await fsp.mkdtemp(path.join(os.tmpdir(), 'rag-ocr-'));
  const inputPath = providedInputPath || path.join(workDirectory, safeName(fileName));
  if (buffer) await fsp.writeFile(inputPath, buffer);
  const checksum = await checksumFile(inputPath);
  const outputFileName = `${checksum.slice(0, 12)}-${safeName(fileName.replace(/\.[^.]+$/, ''))}.json`;
  const outputPath = path.join(extractionsDirectory, outputFileName);

  try {
    const extraction = await runPython(inputPath, sourceKey, fileName);
    extraction.checksum = checksum;
    extraction.absolutePath = absolutePath || null;
    await fsp.writeFile(outputPath, JSON.stringify(extraction, null, 2), 'utf8');
    const imported = ingest({ documents: [extraction] });
    return { extraction, imported, jsonFileName: outputFileName, databaseSaved: true };
  } catch (error) {
    await fsp.unlink(outputPath).catch(() => {});
    throw error;
  } finally {
    if (workDirectory) await fsp.rm(workDirectory, { recursive: true, force: true });
    else await fsp.unlink(inputPath).catch(() => {});
  }
}
