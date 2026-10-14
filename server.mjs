import http from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  buildLivePrompt,
  buildPipelineContext,
  deterministicDemoTranslation,
  DEMO_TRANSLATION_WARNING,
  semanticCautions,
  untranslatedWarning,
} from './lib/pipeline.mjs';
import { exportDocx, exportFdx, exportFountain, exportScreenplayText } from './lib/exporter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, 'schema.sql');
const DEFAULT_DB_PATH = path.join(HERE, 'storage', 'cineverse.sqlite');
const DEFAULT_STORAGE_DIR = path.join(HERE, 'storage');
const DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;
const SESSION_COOKIE = 'cineverse_session';
const SESSION_DAYS = 14;
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TRANSLATION_CHARS = 20000;
const MAX_PROJECT_SEGMENTS = 10000;
const ALLOWED_EXTENSIONS = new Set(['.fountain', '.txt', '.text', '.md', '.markdown', '.docx', '.fdx', '.pdf']);
const JOB_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const JOB_MAX_SEGMENTS = 100;
const PROJECT_ROLES = new Set(['owner', 'editor', 'reviewer', 'viewer']);
const REVIEW_DECISIONS = new Set(['approve', 'approved', 'needs_changes', 'reject', 'rejected', 'ignore']);
const TRANSLATION_MODES = new Set(['literal', 'natural', 'cinematic', 'custom']);
const CONTEXT_DEPTHS = new Set(['shallow', 'balanced', 'deep']);
const ADAPTATIONS = new Set(['direct', 'functional', 'paraphrase', 'retain', 'review']);
const GLOSSARY_CATEGORIES = new Set(['Meaning', 'Emotion', 'Character voice', 'Cultural reference', 'Idiom or humour', 'Terminology', 'Formatting', 'Narrative continuity']);
const EXPORT_FORMATS = new Map([
  ['json', { extension: 'json', contentType: 'application/json; charset=utf-8' }],
  ['txt', { extension: 'txt', contentType: 'text/plain; charset=utf-8' }],
  ['text', { extension: 'txt', contentType: 'text/plain; charset=utf-8' }],
  ['plain', { extension: 'txt', contentType: 'text/plain; charset=utf-8' }],
  ['fountain', { extension: 'fountain', contentType: 'text/plain; charset=utf-8' }],
  ['fdx', { extension: 'fdx', contentType: 'application/xml; charset=utf-8' }],
  ['docx', { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
  ['md', { extension: 'md', contentType: 'text/markdown; charset=utf-8' }],
  ['csv', { extension: 'csv', contentType: 'text/csv; charset=utf-8' }],
  ['glossary', { extension: 'csv', contentType: 'text/csv; charset=utf-8' }],
  ['glossary.csv', { extension: 'csv', contentType: 'text/csv; charset=utf-8' }],
  ['review', { extension: 'txt', contentType: 'text/plain; charset=utf-8' }],
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.fountain': 'text/plain; charset=utf-8',
  '.fdx': 'application/xml; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown; charset=utf-8',
};

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super('An OpenAI-compatible translation provider is not configured. Set CINEVERSE_AI_BASE_URL, CINEVERSE_AI_API_KEY, and CINEVERSE_AI_MODEL on the server.');
    this.code = 'provider_not_configured';
    this.status = 503;
  }
}

function timestamp(date = new Date()) {
  return date.toISOString();
}

function id() {
  return randomUUID();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeName(value, fallback = 'CineVerse user') {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  return (name || fallback).slice(0, 120);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function one(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

function many(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

function tableColumns(db, tableName) {
  return new Set(many(db, `PRAGMA table_info(${tableName})`).map(row => row.name));
}

function addMissingColumn(db, tableName, columnName, declaration) {
  if (!tableColumns(db, tableName).has(columnName)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${declaration}`);
}

/**
 * Keep the shipped SQLite file usable across server upgrades.  SQLite does not
 * support ADD COLUMN IF NOT EXISTS, so migrations intentionally inspect the
 * table first and add only missing fields.  The one legacy glossary table had
 * a table-level uniqueness constraint that prevented scene exceptions; it is
 * copied once into the scene-aware shape while preserving every row.
 */
function migrateDatabase(database) {
  addMissingColumn(database, 'users', 'demo', 'INTEGER NOT NULL DEFAULT 0');
  addMissingColumn(database, 'projects', 'translation_mode', "TEXT NOT NULL DEFAULT 'natural'");
  addMissingColumn(database, 'projects', 'context_depth', "TEXT NOT NULL DEFAULT 'balanced'");
  addMissingColumn(database, 'projects', 'custom_instructions', "TEXT NOT NULL DEFAULT ''");
  addMissingColumn(database, 'projects', 'adaptation', "TEXT NOT NULL DEFAULT 'direct'");
  addMissingColumn(database, 'projects', 'demo', 'INTEGER NOT NULL DEFAULT 0');
  addMissingColumn(database, 'glossary_entries', 'category', "TEXT NOT NULL DEFAULT 'Terminology'");
  addMissingColumn(database, 'glossary_entries', 'scene_id', 'TEXT REFERENCES scenes(id) ON DELETE CASCADE');
  addMissingColumn(database, 'validation_issues', 'category', "TEXT NOT NULL DEFAULT 'Terminology'");
  addMissingColumn(database, 'context_memories', 'source_text', "TEXT NOT NULL DEFAULT ''");
  addMissingColumn(database, 'context_memories', 'target_text', "TEXT NOT NULL DEFAULT ''");
  addMissingColumn(database, 'context_memories', 'note', "TEXT NOT NULL DEFAULT ''");
  addMissingColumn(database, 'context_memories', 'scene_id', 'TEXT REFERENCES scenes(id) ON DELETE SET NULL');
  addMissingColumn(database, 'context_memories', 'created_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
  addMissingColumn(database, 'context_memories', 'created_at', "TEXT NOT NULL DEFAULT ''");

  const legacySql = one(database, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'glossary_entries'")?.sql || '';
  if (/UNIQUE\s*\(\s*project_id\s*,\s*source_term\s*\)/i.test(legacySql)) {
    executeTransaction(database, () => {
      database.exec(`CREATE TABLE glossary_entries_scene_migration (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_term TEXT NOT NULL,
        target_term TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        case_sensitive INTEGER NOT NULL DEFAULT 0,
        category TEXT NOT NULL DEFAULT 'Terminology',
        scene_id TEXT REFERENCES scenes(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      database.exec(`INSERT INTO glossary_entries_scene_migration
        (id, project_id, source_term, target_term, notes, case_sensitive, category, scene_id, created_at, updated_at)
        SELECT id, project_id, source_term, target_term, notes, case_sensitive,
          COALESCE(category, 'Terminology'), scene_id, created_at, updated_at
        FROM glossary_entries`);
      database.exec('DROP TABLE glossary_entries');
      database.exec('ALTER TABLE glossary_entries_scene_migration RENAME TO glossary_entries');
    });
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_glossary_project ON glossary_entries(project_id, source_term)');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_global_term ON glossary_entries(project_id, source_term) WHERE scene_id IS NULL');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_scene_term ON glossary_entries(project_id, scene_id, source_term) WHERE scene_id IS NOT NULL');
  database.exec('CREATE INDEX IF NOT EXISTS idx_context_memories_project ON context_memories(project_id, created_at DESC)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_context_memories_scene ON context_memories(project_id, scene_id, created_at DESC)');
}

function executeTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }
}

export function createDatabase(dbPath = DEFAULT_DB_PATH) {
  const inMemory = dbPath === ':memory:';
  const resolved = inMemory ? dbPath : path.resolve(dbPath);
  const parent = inMemory ? null : path.dirname(resolved);
  // DatabaseSync is synchronous, so create the directory before opening it.
  // The caller normally passes a path below the workspace storage directory.
  if (parent) requireDirectory(parent);
  const database = new DatabaseSync(resolved);
  database.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrateDatabase(database);
  return database;
}

function requireDirectory(directory) {
  // mkdirSync is intentionally imported lazily to keep the main fs import promise based.
  // It is safe for createDatabase to use the synchronous primitive during startup.
  // eslint-free codebase: this helper is replaced below by a direct dynamic require-free call.
  // eslint-disable-next-line no-sync
  const { mkdirSync } = requireNodeFs();
  mkdirSync(directory, { recursive: true });
}

function requireNodeFs() {
  // ESM has no require; the object is populated once at module initialization below.
  return nodeFsSync;
}

import * as nodeFsSync from 'node:fs';

function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, saltText, hashText] = String(encoded).split('$');
    if (algorithm !== 'scrypt' || !n || !r || !p || !saltText || !hashText) return false;
    if (Number(n) !== 16384 || Number(r) !== 8 || Number(p) !== 1) return false;
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.display_name,
    displayName: row.display_name,
    demo: Boolean(row.demo),
    createdAt: row.created_at,
  };
}

function sessionToken() {
  return randomBytes(32).toString('base64url');
}

function tokenHash(token) {
  return sha256(token);
}

function createSession(db, userId, days = SESSION_DAYS) {
  const token = sessionToken();
  const createdAt = new Date();
  const expires = new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000);
  run(db, 'INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [
    id(), userId, tokenHash(token), timestamp(expires), timestamp(createdAt),
  ]);
  return { token, expiresAt: timestamp(expires) };
}

function parseCookies(header) {
  const result = {};
  for (const item of String(header ?? '').split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value); } catch { /* ignore malformed cookies */ }
  }
  return result;
}

function sessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE]) return cookies[SESSION_COOKIE];
  const authorization = String(req.headers.authorization ?? '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return null;
}

function authenticatedUser(db, req) {
  const token = sessionTokenFromRequest(req);
  if (!token) return null;
  const row = one(db, `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`, [tokenHash(token), timestamp()]);
  return userFromRow(row);
}

function requireUser(db, req) {
  const user = authenticatedUser(db, req);
  if (!user) throw new ApiError(401, 'unauthorized', 'Sign in is required for this request.');
  return user;
}

function setSessionCookie(res, token, maxAgeSeconds, options = {}) {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  if (options.secure || parseBoolean(process.env.CINEVERSE_COOKIE_SECURE, process.env.NODE_ENV === 'production')) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function validateRegistration(body) {
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new ApiError(400, 'invalid_email', 'Enter a valid email address.');
  }
  if (password.length < 8 || password.length > 128) {
    throw new ApiError(400, 'invalid_password', 'Password must be between 8 and 128 characters.');
  }
  return { email, password, name: normalizeName(body.name ?? body.displayName, email.split('@')[0]) };
}

function enumField(value, name, allowed, fallback) {
  const result = String(value ?? fallback).trim().toLowerCase();
  if (!allowed.has(result)) throw new ApiError(400, `invalid_${name}`, `${name} must be one of: ${[...allowed].join(', ')}.`);
  return result;
}

function projectSettingsFromBody(body, existing = {}) {
  return {
    translationMode: enumField(body.translationMode ?? existing.translation_mode, 'translationMode', TRANSLATION_MODES, 'natural'),
    contextDepth: enumField(body.contextDepth ?? existing.context_depth, 'contextDepth', CONTEXT_DEPTHS, 'balanced'),
    customInstructions: textField(body.customInstructions ?? existing.custom_instructions, 'customInstructions', { max: 4000 }),
    adaptation: enumField(body.adaptation ?? existing.adaptation, 'adaptation', ADAPTATIONS, 'direct'),
  };
}

function glossaryCategory(value, fallback = 'Terminology') {
  const supplied = String(value ?? fallback).trim().toLocaleLowerCase();
  const match = [...GLOSSARY_CATEGORIES].find(item => item.toLocaleLowerCase() === supplied);
  if (!match) throw new ApiError(400, 'invalid_category', `category must be one of: ${[...GLOSSARY_CATEGORIES].join(', ')}.`);
  return match;
}

function normalizeText(input) {
  return String(input ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .normalize('NFC');
}

function normalizeForId(input) {
  return normalizeText(input).trim().replace(/\s+/g, ' ');
}

function isSceneHeading(line) {
  return /^(?:INT\.?|EXT\.?|INT\.?\/\.?EXT\.?|I\.?\/\.?E\.?)\s*[-.]/i.test(line.trim())
    || /^(?:INT\.?|EXT\.?|INT\.?\/\.?EXT\.?|I\.?\/\.?E\.?)\s+/i.test(line.trim());
}

function isTransition(line) {
  const value = line.trim();
  if (!value) return false;
  return /^(?:FADE\s+(?:IN|OUT)|CUT\s+TO|SMASH\s+CUT\s+TO|DISSOLVE\s+TO|MATCH\s+CUT\s+TO|JUMP\s+CUT\s+TO|IRIS\s+(?:IN|OUT))\b:?\.?$/i.test(value)
    || (/^[A-Z0-9 ._'&()/-]+TO:$/.test(value) && value.length <= 80)
    || /^>\s*.+/.test(value);
}

function deliveryForCue(cue) {
  const match = cue.match(/\(([^)]*)\)\s*$/);
  const modifier = (match ? match[1] : cue).toUpperCase().replace(/\s+/g, ' ').trim();
  if (/\b(?:V\.?O\.?|VOICE\s*OVER)\b/.test(modifier)) return 'voice_over';
  if (/\b(?:O\.?S\.?|O\.?C\.?|OSW|OFF\s*SCREEN|OFFSCREEN)\b/.test(modifier)) return 'off_screen';
  return 'on_screen';
}

function characterNameFromCue(cue) {
  return cue.trim().replace(/^@/, '').replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+(?:V\.?O\.?|O\.?S\.?|O\.?C\.?|OSW|OFF\s*SCREEN|OFFSCREEN)\s*$/i, '').trim();
}

function isParenthetical(line) {
  const value = line.trim();
  return /^\([^\n]{1,240}\)$/.test(value);
}

function looksLikeCharacterCue(lines, index) {
  const raw = lines[index]?.trim() ?? '';
  if (!raw || isSceneHeading(raw) || isTransition(raw) || isParenthetical(raw)) return false;
  const candidate = raw.startsWith('@') ? raw.slice(1).trim() : raw;
  if (!candidate || candidate.length > 100 || !/[A-Za-z]/.test(candidate)) return false;
  const upper = candidate.toUpperCase();
  if (candidate !== upper && !raw.startsWith('@') && deliveryForCue(raw) === 'on_screen') return false;
  if (/^[#].*/.test(candidate) || /^\d+[.)]/.test(candidate)) return false;
  if (/[!?;:,]$/.test(candidate)) return false;
  let next = index + 1;
  while (next < lines.length && !lines[next].trim()) next += 1;
  if (next >= lines.length) return false;
  return isParenthetical(lines[next]) || !isSceneHeading(lines[next]) && !isTransition(lines[next]);
}

function stableIdFor(documentKey, sceneKey, ordinal, type, text) {
  return `seg_${sha256(`${documentKey}|${sceneKey}|${ordinal}|${type}|${normalizeForId(text)}`).slice(0, 24)}`;
}

/**
 * Parse a Fountain/plain screenplay into stable, line-aware segments.
 * `type` remains `dialogue` for ordinary speech and carries voice_over/off_screen
 * in `delivery`, `segmentType`, and boolean flags for clients that need that detail.
 */
export function parseScreenplay(source, options = {}) {
  const text = normalizeText(source);
  const lines = text.split('\n');
  const documentKey = options.documentKey || sha256(text);
  const segments = [];
  const scenes = [];
  let currentScene = null;
  let ordinal = 0;
  let sceneNumber = 0;

  const addSegment = (type, value, start, end, extra = {}) => {
    const clean = String(value ?? '').trim();
    if (!clean) return null;
    const sceneKey = currentScene?.stableId || 'scene_unassigned';
    const delivery = extra.delivery || null;
    const segmentType = type === 'dialogue' && delivery && delivery !== 'on_screen' ? delivery : type;
    const segment = {
      stableId: stableIdFor(documentKey, sceneKey, ordinal, type, clean),
      ordinal,
      type,
      baseType: type === 'dialogue' ? 'dialogue' : type,
      segmentType,
      text: clean,
      sourceText: clean,
      lineStart: start + 1,
      lineEnd: end + 1,
      sceneStableId: currentScene?.stableId || null,
      speaker: extra.speaker || null,
      delivery,
      isVoiceOver: delivery === 'voice_over',
      isOffScreen: delivery === 'off_screen',
      sourceHash: sha256(clean),
    };
    segments.push(segment);
    ordinal += 1;
    return segment;
  };

  const addScene = (heading, lineIndex) => {
    sceneNumber += 1;
    const sceneStableId = `scene_${sha256(`${documentKey}|${sceneNumber}|${normalizeForId(heading)}`).slice(0, 24)}`;
    currentScene = {
      stableId: sceneStableId,
      sceneNumber,
      heading: heading.trim(),
      lineStart: lineIndex + 1,
      lineEnd: lineIndex + 1,
    };
    scenes.push(currentScene);
    addSegment('scene_heading', heading, lineIndex, lineIndex, { sceneStableId });
  };

  if (options.paragraphs) {
    let speaker = null;
    let delivery = null;
    for (const paragraph of options.paragraphs) {
      const { type, text: value, start, end } = paragraph;
      if (type === 'scene_heading') {
        addScene(value, start);
        speaker = null;
        delivery = null;
      } else if (type === 'character') {
        speaker = characterNameFromCue(value);
        delivery = deliveryForCue(value);
        addSegment(type, speaker, start, end, { speaker, delivery });
      } else if (type === 'dialogue' || type === 'parenthetical') {
        addSegment(type, value, start, end, { speaker, delivery });
      } else {
        addSegment(type, value, start, end);
        speaker = null;
        delivery = null;
      }
    }
    return { text, lines, scenes, segments, documentKey };
  }

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const value = line.trim();
    if (!value) {
      index += 1;
      continue;
    }
    if (/^(?:Title|Credit|Author|Source|Draft date|Contact):\s*/i.test(value) && !currentScene) {
      index += 1;
      continue;
    }
    if (/^\[\[.*\]\]$/.test(value) || /^\/\*.*\*\/$/.test(value)) {
      index += 1;
      continue;
    }
    if (isSceneHeading(value)) {
      addScene(value, index);
      index += 1;
      continue;
    }
    if (isTransition(value)) {
      addSegment('transition', value.replace(/^>\s*/, ''), index, index);
      index += 1;
      continue;
    }
    if (looksLikeCharacterCue(lines, index)) {
      const cue = value;
      const speaker = characterNameFromCue(cue);
      const delivery = deliveryForCue(cue);
      addSegment('character', speaker, index, index, { speaker, delivery });
      index += 1;
      let hasDialogue = false;
      while (index < lines.length) {
        if (hasDialogue && !lines[index].trim()) {
          while (index < lines.length && !lines[index].trim()) index += 1;
          break;
        }
        while (index < lines.length && !lines[index].trim()) index += 1;
        if (index >= lines.length) break;
        const nextValue = lines[index].trim();
        if (isSceneHeading(nextValue) || isTransition(nextValue) || looksLikeCharacterCue(lines, index)) break;
        if (isParenthetical(nextValue)) {
          addSegment('parenthetical', nextValue, index, index, { speaker, delivery });
          index += 1;
          continue;
        }
        const dialogueStart = index;
        const dialogueLines = [];
        while (index < lines.length && lines[index].trim()) {
          const dialogueValue = lines[index].trim();
          if (index !== dialogueStart && (isSceneHeading(dialogueValue) || isTransition(dialogueValue) || looksLikeCharacterCue(lines, index))) break;
          if (isParenthetical(dialogueValue) && dialogueLines.length) break;
          dialogueLines.push(dialogueValue);
          index += 1;
        }
        if (dialogueLines.length) {
          addSegment('dialogue', dialogueLines.join('\n'), dialogueStart, index - 1, { speaker, delivery });
          hasDialogue = true;
        }
        if (index < lines.length && (isSceneHeading(lines[index].trim()) || isTransition(lines[index].trim()) || looksLikeCharacterCue(lines, index))) break;
      }
      continue;
    }
    if (isParenthetical(value)) {
      addSegment('parenthetical', value, index, index);
      index += 1;
      continue;
    }
    addSegment('action', value, index, index);
    index += 1;
  }

  return { text, lines, scenes, segments, documentKey };
}

function decodeXmlEntities(value) {
  const entities = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return String(value).replace(/&([^;\s<&]*);|&/g, (_, entity) => {
    if (Object.hasOwn(entities, entity)) return entities[entity];
    const number = /^#x[0-9a-f]+$/i.test(entity || '') ? parseInt(entity.slice(2), 16)
      : /^#\d+$/.test(entity || '') ? Number(entity.slice(1)) : NaN;
    if (number === 9 || number === 10 || number === 13 || (number >= 0x20 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) && number !== 0xfffe && number !== 0xffff)) {
      return String.fromCodePoint(number);
    }
    throw new ApiError(422, 'parser_unavailable', 'The document contains an invalid XML entity.');
  });
}

function zipEntries(buffer) {
  const eocd = 0x06054b50;
  const maxEntries = 1000;
  const maxEntryBytes = 25 * 1024 * 1024;
  const maxTotalBytes = 40 * 1024 * 1024;
  let eocdOffset = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65557); index -= 1) {
    if (index >= 0 && buffer.readUInt32LE(index) === eocd) { eocdOffset = index; break; }
  }
  if (eocdOffset < 0) throw new ApiError(422, 'parser_unavailable', 'The DOCX archive could not be read.');
  const count = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (count > maxEntries || centralOffset < 0 || centralOffset >= buffer.length) {
    throw new ApiError(422, 'parser_unavailable', 'The DOCX archive is too large or malformed.');
  }
  const entries = new Map();
  let totalBytes = 0;
  let offset = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ApiError(422, 'parser_unavailable', 'The DOCX archive has an invalid directory.');
    }
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name || entries.has(name) || (buffer.readUInt16LE(offset + 8) & 1) || name.includes('\\') || name.split('/').some(part => part === '..') || name.startsWith('/')
      || uncompressedSize > maxEntryBytes || totalBytes + uncompressedSize > maxTotalBytes) {
      throw new ApiError(422, 'parser_unavailable', 'The DOCX archive contains an unsafe or oversized entry.');
    }
    totalBytes += uncompressedSize;
    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (start < 0 || start > buffer.length || compressedSize > buffer.length - start) {
        throw new ApiError(422, 'parser_unavailable', 'The DOCX archive contains an invalid entry.');
      }
      const compressed = buffer.subarray(start, start + compressedSize);
      let contents;
      if (compression === 0) contents = compressed;
      else if (compression === 8) {
        try { contents = inflateRawSync(compressed, { maxOutputLength: Math.min(maxEntryBytes, uncompressedSize + 1) }); }
        catch { throw new ApiError(422, 'parser_unavailable', 'The DOCX archive contains an unreadable compressed entry.'); }
      } else throw new ApiError(422, 'parser_unavailable', 'The DOCX uses an unsupported compression method.');
      if (contents.length !== uncompressedSize) throw new ApiError(422, 'parser_unavailable', 'The DOCX archive entry has an invalid size.');
      entries.set(name, contents);
    } else {
      throw new ApiError(422, 'parser_unavailable', 'The DOCX archive contains an invalid entry.');
    }
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > buffer.length) throw new ApiError(422, 'parser_unavailable', 'The DOCX archive directory is truncated.');
  }
  return entries;
}

export function extractDocxText(buffer) {
  try {
    const entries = zipEntries(Buffer.from(buffer));
    const xml = entries.get('word/document.xml');
    if (!xml) throw new ApiError(422, 'parser_unavailable', 'The DOCX does not contain word/document.xml.');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(xml);
    if (/<!(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new ApiError(422, 'parser_unavailable', 'The DOCX contains unsupported XML declarations.');
    const paragraphs = [];
    for (const paragraph of source.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)) {
      const value = [...paragraph[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
        .map(match => decodeXmlEntities(match[1])).join('');
      // Empty Word paragraphs are screenplay boundaries.  Retaining them is
      // important for separating a cue from its next block.
      paragraphs.push(value);
    }
    const text = normalizeText(paragraphs.join('\n'));
    if (!text.trim()) throw new ApiError(422, 'empty_file', 'The DOCX contains no readable text.');
    return text;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'parser_unavailable', 'This DOCX could not be parsed by the built-in reader.');
  }
}

function extractFdx(buffer) {
  try {
    const source = normalizeText(Buffer.from(buffer).toString('utf8'));
    if (/<!(?:DOCTYPE|ENTITY)\b/i.test(source)) {
      throw new ApiError(422, 'parser_unavailable', 'The FDX contains unsupported XML declarations.');
    }
    // A bounded XML tokenizer: declarations/entities are never resolved and
    // typed screenplay paragraphs are kept separate from title pages and notes.
    const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/[A-Za-z_][\w:.-]*\s*>|<[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
    const stack = [];
    const sourceParagraphs = [];
    let paragraph = null;
    let rootSeen = false;
    let contentSeen = false;
    let offset = 0;
    const malformed = () => { throw new ApiError(422, 'parser_unavailable', 'The FDX contains malformed Final Draft XML.'); };
    while (offset < source.length) {
      tokens.lastIndex = offset;
      const match = tokens.exec(source);
      if (!match) malformed();
      const token = match[0];
      offset = tokens.lastIndex;
      if (token.startsWith('<!--') || token.startsWith('<?')) continue;
      if (token.startsWith('<![CDATA[') || !token.startsWith('<')) {
        const cdata = token.startsWith('<![CDATA[');
        if (!stack.length && (cdata || token.trim())) malformed();
        const value = cdata ? token.slice(9, -3) : decodeXmlEntities(token);
        if (paragraph && stack.at(-1) === 'Text' && stack.length === paragraph.depth + 1) paragraph.text += value;
        continue;
      }
      if (token.startsWith('</')) {
        const name = token.slice(2, -1).trim();
        if (stack.at(-1) !== name) malformed();
        if (paragraph && name === 'Paragraph' && stack.length === paragraph.depth) {
          sourceParagraphs.push(paragraph);
          paragraph = null;
        }
        stack.pop();
        continue;
      }
      const name = token.match(/^<([\w:.-]+)/)[1];
      const attributes = new Map();
      for (const attribute of token.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        if (attributes.has(attribute[1])) malformed();
        attributes.set(attribute[1], decodeXmlEntities(attribute[2] ?? attribute[3]));
      }
      if (!stack.length) {
        if (rootSeen || name !== 'FinalDraft') malformed();
        rootSeen = true;
      }
      if (stack.length === 1 && name === 'Content') {
        if (contentSeen) malformed();
        contentSeen = true;
      }
      const selfClosing = token.endsWith('/>');
      if (!selfClosing) {
        stack.push(name);
        if (stack.length > 100) malformed();
        if (name === 'Paragraph' && stack[1] === 'Content' && !paragraph) {
          paragraph = { type: attributes.get('Type') || 'Action', text: '', depth: stack.length };
        }
      }
    }
    if (stack.length || !rootSeen || !contentSeen) malformed();
    const types = { 'scene heading': 'scene_heading', sceneheading: 'scene_heading', character: 'character', dialogue: 'dialogue', parenthetical: 'parenthetical', transition: 'transition' };
    const paragraphs = [];
    const lines = [];
    for (const item of sourceParagraphs) {
      const value = normalizeText(item.text).trim();
      if (!value) continue;
      const type = types[item.type.toLowerCase()] || 'action';
      if (lines.length && !['dialogue', 'parenthetical'].includes(type)) lines.push('');
      const start = lines.length;
      lines.push(...value.split('\n'));
      paragraphs.push({ type, text: value, start, end: lines.length - 1 });
    }
    const text = lines.join('\n');
    if (!text.trim()) throw new ApiError(422, 'empty_file', 'The FDX contains no readable screenplay text.');
    return { text, paragraphs };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'parser_unavailable', 'This FDX could not be parsed by the built-in reader.');
  }
}

export function extractFdxText(buffer) {
  return extractFdx(buffer).text;
}

function decodePdfLiteral(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\') { output += value[index]; continue; }
    const next = value[++index];
    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '(': '(', ')': ')' };
    if (escapes[next] !== undefined) { output += escapes[next]; continue; }
    if (/[0-7]/.test(next || '')) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] || '')) octal += value[++index];
      output += String.fromCharCode(parseInt(octal, 8));
    } else if (next) output += next;
  }
  return output;
}

function decodePdfHex(value) {
  const normalized = value.replace(/\s/g, '').padEnd(value.length % 2 ? value.length + 1 : value.length, '0');
  const bytes = Buffer.from(normalized, 'hex');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let result = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) result += String.fromCharCode(bytes.readUInt16BE(i));
    return result;
  }
  return bytes.toString('utf8');
}

function textFromPdfOperators(source) {
  const regionPattern = /BT([\s\S]*?)ET/g;
  const regions = [...source.matchAll(regionPattern)].map(match => match[1]);
  // Operators outside a complete text object cannot be ordered reliably.  Do
  // not sample them as if they were screenplay text.
  if (!regions.length) return '';
  const renderedRegions = [];
  for (const region of regions) {
    const values = [];
    let cursor = 0;
    // Scan all text operators in stream order.  Separate passes for Tj and TJ
    // would silently reorder mixed literal/hex/array content.
    const operations = /(?:\((?:\\.|[^\\)])*\)|<([0-9a-f\s]+)>)\s*Tj|\[([\s\S]*?)\]\s*TJ/gi;
    for (const match of region.matchAll(operations)) {
      const gap = region.slice(cursor, match.index);
      const separator = /(?:T\*|T[dD]|Tm)\b/.test(gap) ? '\n' : (values.length ? ' ' : '');
      if (match[2] !== undefined) {
        const parts = [];
        for (const literal of match[2].matchAll(/\((?:\\.|[^\\)])*\)|<([0-9a-f\s]+)>/gi)) {
          const value = literal[0];
          parts.push(value.startsWith('<') ? decodePdfHex(value.slice(1, -1)) : decodePdfLiteral(value.slice(1, -1)));
        }
        if (parts.length) values.push(`${separator}${parts.join('')}`);
      } else {
        const token = match[0].replace(/\s*Tj\s*$/, '');
        const value = match[1] !== undefined ? decodePdfHex(match[1]) : decodePdfLiteral(token.slice(1, -1));
        if (value) values.push(`${separator}${value}`);
      }
      cursor = match.index + match[0].length;
    }
    renderedRegions.push(values.join(''));
  }
  return normalizeText(renderedRegions.join('\n').replace(/[ \t]+\n/g, '\n'));
}

export function extractPdfText(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new ApiError(422, 'parser_unavailable', 'The file is not a readable PDF.');
  }
  const raw = bytes.toString('latin1');
  const rawForChecks = raw.replace(/stream\r?\n[\s\S]*?endstream/g, 'stream endstream');
  if (/\bBT\b/.test(rawForChecks) && !/BT[\s\S]*ET/.test(rawForChecks)) throw new ApiError(422, 'parser_unavailable', 'The PDF contains an incomplete text object; extraction was refused to preserve ordering.');
  const textOperatorsOutsideTextObject = /\b(?:Tj|TJ)\b/.test(rawForChecks) && !/BT[\s\S]*ET/.test(rawForChecks);
  if (textOperatorsOutsideTextObject) throw new ApiError(422, 'parser_unavailable', 'The PDF contains text operators without an ordered text object; extraction was refused to avoid losing screenplay order.');
  const textParts = [];
  const orderedParts = [];
  for (const region of raw.matchAll(/BT([\s\S]*?)ET/g)) {
    const extracted = textFromPdfOperators(`BT${region[1]}ET`);
    if (extracted.trim()) orderedParts.push({ index: region.index, text: extracted });
  }
  for (const stream of raw.matchAll(/<<([\s\S]*?)>>\s*stream\r?\n([\s\S]*?)endstream/g)) {
    if (!/FlateDecode/i.test(stream[1])) continue;
    try {
      const compressed = Buffer.from(stream[2], 'latin1');
      const extracted = textFromPdfOperators(inflateSync(compressed, { maxOutputLength: 25 * 1024 * 1024 }).toString('latin1'));
      if (extracted.trim()) orderedParts.push({ index: stream.index, text: extracted });
    } catch { /* an unsupported stream is handled as OCR_REQUIRED below */ }
  }
  orderedParts.sort((a, b) => a.index - b.index);
  textParts.push(...orderedParts.map(part => part.text));
  const text = normalizeText(textParts.join('\n'));
  if (!text.trim()) throw new ApiError(422, 'OCR_REQUIRED', 'OCR_REQUIRED: this PDF does not contain extractable text; a scanned-PDF OCR pass is required.');
  return text;
}

function filenameIsSafe(filename) {
  return filename && filename.length <= 255 && filename !== '.' && filename !== '..'
    && !/[\\/\0-\x1f\x7f]/.test(filename);
}

function extensionOf(filename) {
  return path.extname(filename).toLowerCase();
}

function asBuffer(value, encoding) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (encoding === 'base64') {
    const encoded = String(value ?? '').trim();
    if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded.replace(/-/g, '+').replace(/_/g, '/'))) {
      throw new ApiError(400, 'invalid_file_encoding', 'The uploaded file is not valid base64 data.');
    }
    return Buffer.from(encoded, 'base64url');
  }
  return Buffer.from(String(value ?? ''), 'utf8');
}

function validateFileSignature(extension, bytes) {
  if (extension === '.docx' && !(bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new ApiError(415, 'invalid_file_signature', 'The DOCX upload does not contain a valid ZIP signature.');
  }
  if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new ApiError(415, 'invalid_file_signature', 'The PDF upload does not contain a valid PDF signature.');
  }
  if (extension !== '.docx' && extension !== '.pdf') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ApiError(415, 'invalid_file_signature', 'The text screenplay must contain valid UTF-8 text.'); }
    if (/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
      throw new ApiError(415, 'invalid_file_signature', 'The text screenplay contains binary data.');
    }
    if (extension === '.fdx' && !/^\s*(?:(?:<\?[\s\S]*?\?>)|(?:<!--[\s\S]*?-->))*\s*<FinalDraft\b/i.test(normalizeText(text))) {
      throw new ApiError(415, 'invalid_file_signature', 'The FDX upload does not contain a valid Final Draft XML signature.');
    }
  }
}

export function parseUpload(upload, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_UPLOAD_LIMIT;
  const filename = String(upload?.filename ?? upload?.name ?? 'pasted.fountain');
  if (!filenameIsSafe(filename)) throw new ApiError(400, 'unsafe_filename', 'The upload filename contains an unsafe path or control character.');
  const extension = extensionOf(filename) || '.fountain';
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ApiError(415, 'unsupported_file_type', `Unsupported screenplay file type: ${extension || 'unknown'}.`);
  }
  const bytes = asBuffer(upload?.data ?? upload?.content ?? upload?.text ?? '', upload?.encoding);
  if (bytes.length === 0) throw new ApiError(400, 'empty_file', 'The uploaded file is empty.');
  if (bytes.length > maxBytes) throw new ApiError(413, 'file_too_large', `Uploads are limited to ${maxBytes} bytes.`);
  validateFileSignature(extension, bytes);
  let text;
  let paragraphs;
  let parserStatus = 'parsed';
  if (extension === '.docx') text = extractDocxText(bytes);
  else if (extension === '.fdx') ({ text, paragraphs } = extractFdx(bytes));
  else if (extension === '.pdf') text = extractPdfText(bytes);
  else text = normalizeText(bytes.toString('utf8'));
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new ApiError(413, 'text_too_large', `Extracted screenplay text is limited to ${MAX_TEXT_BYTES} bytes.`);
  if (!text.trim()) throw new ApiError(400, 'empty_file', 'The upload contains no readable screenplay text.');
  const result = {
    filename,
    extension,
    mimeType: extension === '.docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : extension === '.pdf' ? 'application/pdf' : (MIME_TYPES[extension] || 'text/plain').split(';')[0],
    bytes,
    text,
    parserStatus,
    sha256: sha256(bytes),
  };
  if (paragraphs) result.paragraphs = paragraphs;
  return result;
}

function projectFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    translationMode: row.translation_mode || 'natural',
    contextDepth: row.context_depth || 'balanced',
    customInstructions: row.custom_instructions || '',
    adaptation: row.adaptation || 'direct',
    demo: Boolean(row.demo),
    status: row.status,
    role: row.role || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    segmentCount: row.segment_count === undefined ? undefined : Number(row.segment_count),
    translatedCount: row.translated_count === undefined ? undefined : Number(row.translated_count),
    approvedCount: row.approved_count === undefined ? undefined : Number(row.approved_count),
    issueCount: row.issue_count === undefined ? undefined : Number(row.issue_count),
  };
}

function sceneFromRow(row) {
  return {
    id: row.id,
    stableId: row.stable_id,
    sceneNumber: Number(row.scene_number),
    heading: row.heading,
    lineStart: row.line_start,
    lineEnd: row.line_end,
  };
}

function segmentFromRow(row) {
  const translation = row.manual_translation ?? row.translation ?? null;
  return {
    id: row.id,
    stableId: row.stable_id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    sourceFileId: row.source_file_id,
    ordinal: Number(row.ordinal),
    type: row.type,
    baseType: row.base_type,
    segmentType: row.segment_type || (row.type === 'dialogue' && row.delivery && row.delivery !== 'on_screen' ? row.delivery : row.type),
    text: row.text,
    sourceText: row.text,
    translation,
    translatedText: translation,
    manualTranslation: row.manual_translation,
    approved: Boolean(row.approved),
    approvalStatus: row.approved ? 'approved' : 'pending',
    translationStatus: row.translation_status,
    speaker: row.speaker,
    delivery: row.delivery,
    isVoiceOver: row.delivery === 'voice_over',
    isOffScreen: row.delivery === 'off_screen',
    lineStart: row.line_start,
    lineEnd: row.line_end,
    sourceHash: row.source_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sourceFileFromRow(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    parserStatus: row.parser_status,
    createdAt: row.created_at,
  };
}

function jobFromRow(row) {
  if (!row) return null;
  let result = {};
  try { result = JSON.parse(row.result_json || '{}'); } catch { result = {}; }
  return {
    id: row.id,
    projectId: row.project_id,
    jobType: row.job_type,
    status: JOB_STATUSES.has(row.status) ? row.status : 'failed',
    progress: clamp(Number(row.progress) || 0, 0, 100),
    total: Math.max(0, Number(row.total) || 0),
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    result,
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function glossaryFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceTerm: row.source_term,
    targetTerm: row.target_term,
    notes: row.notes,
    caseSensitive: Boolean(row.case_sensitive),
    category: row.category || 'Terminology',
    sceneId: row.scene_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function memoryFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceText: row.source_text,
    targetText: row.target_text,
    note: row.note,
    sceneId: row.scene_id || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
  };
}

function rowForSegment(db, projectId, segmentId) {
  return one(db, `SELECT s.*, CASE WHEN s.type = 'dialogue' AND s.delivery != 'on_screen' THEN s.delivery ELSE s.type END AS segment_type
    FROM segments s WHERE s.project_id = ? AND (s.id = ? OR s.stable_id = ?)`, [projectId, segmentId, segmentId]);
}

function getProjectAccess(db, projectId, userId) {
  return one(db, `SELECT p.*, m.role FROM projects p
    JOIN memberships m ON m.project_id = p.id AND m.user_id = ? WHERE p.id = ?`, [userId, projectId]);
}

function requireProject(db, projectId, userId, mutation = false) {
  const row = getProjectAccess(db, projectId, userId);
  if (!row) {
    const exists = one(db, 'SELECT id FROM projects WHERE id = ?', [projectId]);
    if (!exists) throw new ApiError(404, 'project_not_found', 'Project not found.');
    throw new ApiError(403, 'forbidden', 'You do not have access to this project.');
  }
  if (mutation && !['owner', 'editor'].includes(row.role)) {
    throw new ApiError(403, 'project_read_only', 'Your project membership is read-only.');
  }
  return row;
}

function projectStats(db, projectId) {
  return one(db, `SELECT
      (SELECT COUNT(*) FROM segments WHERE project_id = ?) AS segment_count,
      (SELECT COUNT(*) FROM segments WHERE project_id = ? AND COALESCE(manual_translation, translation) IS NOT NULL AND COALESCE(manual_translation, translation) != '') AS translated_count,
      (SELECT COUNT(*) FROM segments WHERE project_id = ? AND approved = 1) AS approved_count,
      (SELECT COUNT(*) FROM validation_issues WHERE project_id = ? AND resolved = 0) AS issue_count`, [projectId, projectId, projectId, projectId]);
}

function createUploadFromBody(body, requestInfo = {}) {
  if (body && body.file && typeof body.file === 'object') {
    return {
      filename: body.file.name || body.file.filename || body.fileName || 'pasted.fountain',
      mimeType: body.file.type || body.file.mimeType || 'text/plain',
      data: body.file.data ?? body.file.content ?? body.file.text ?? '',
      encoding: body.file.encoding,
    };
  }
  if (body && body.sourceFile && typeof body.sourceFile === 'object') {
    return {
      filename: body.sourceFile.name || body.sourceFile.filename || body.fileName || 'pasted.fountain',
      mimeType: body.sourceFile.type || body.sourceFile.mimeType || 'text/plain',
      data: body.sourceFile.data ?? body.sourceFile.content ?? body.sourceFile.text ?? '',
      encoding: body.sourceFile.encoding,
    };
  }
  const pasted = body?.sourceText ?? body?.screenplay ?? body?.text ?? body?.content;
  if (pasted !== undefined) {
    return {
      filename: body.fileName || body.filename || requestInfo.fileName || 'pasted.fountain',
      mimeType: body.mimeType || requestInfo.mimeType || 'text/plain',
      data: String(pasted),
    };
  }
  if (requestInfo.raw && requestInfo.raw.length) {
    return {
      filename: requestInfo.fileName || 'pasted.fountain',
      mimeType: requestInfo.mimeType || 'text/plain',
      data: requestInfo.raw,
    };
  }
  return null;
}

function addCharactersAndRelationships(db, projectId, parsed) {
  const characterIds = new Map();
  for (const segment of parsed.segments.filter(item => item.type === 'character')) {
    const name = normalizeName(segment.speaker || segment.text, 'Unnamed character');
    const normalized = name.toLocaleLowerCase();
    let row = one(db, 'SELECT id FROM characters WHERE project_id = ? AND normalized_name = ?', [projectId, normalized]);
    if (!row) {
      const characterId = id();
      run(db, `INSERT INTO characters(id, project_id, name, normalized_name, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [characterId, projectId, name, normalized, JSON.stringify({ delivery: segment.delivery }), timestamp()]);
      row = { id: characterId };
    }
    characterIds.set(normalized, row.id);
  }
  const byScene = new Map();
  for (const segment of parsed.segments.filter(item => item.type === 'character')) {
    const scene = segment.sceneStableId || 'scene_unassigned';
    const normalized = normalizeName(segment.speaker || segment.text, 'Unnamed character').toLocaleLowerCase();
    if (!byScene.has(scene)) byScene.set(scene, []);
    if (!byScene.get(scene).includes(normalized)) byScene.get(scene).push(normalized);
  }
  for (const names of byScene.values()) {
    for (let index = 0; index < names.length; index += 1) {
      for (let other = index + 1; other < names.length; other += 1) {
        const a = characterIds.get(names[index]);
        const b = characterIds.get(names[other]);
        if (!a || !b) continue;
        run(db, `INSERT OR IGNORE INTO character_relationships
          (id, project_id, character_a_id, character_b_id, relationship_type, confidence, notes, created_at)
          VALUES (?, ?, ?, ?, 'co_occurrence', ?, '', ?)`, [id(), projectId, a, b, 0.5, timestamp()]);
      }
    }
  }
}

async function persistUpload({ db, project, user, upload, storageDir, maxBytes }) {
  const parsedUpload = parseUpload(upload, { maxBytes });
  if (one(db, 'SELECT id FROM source_files WHERE project_id = ? AND sha256 = ?', [project.id, parsedUpload.sha256])) {
    throw new ApiError(409, 'duplicate_source_file', 'This screenplay file is already attached to the project.');
  }
  const parsed = parseScreenplay(parsedUpload.text, { paragraphs: parsedUpload.paragraphs });
  if (parsed.segments.length > MAX_PROJECT_SEGMENTS) throw new ApiError(413, 'too_many_segments', `A project may contain at most ${MAX_PROJECT_SEGMENTS} screenplay segments.`);
  const sourceFileId = id();
  const directory = path.join(storageDir, 'uploads', project.id);
  await fs.mkdir(directory, { recursive: true });
  const storedName = `${sourceFileId}${parsedUpload.extension}`;
  const absolutePath = path.join(directory, storedName);
  const relativePath = path.relative(storageDir, absolutePath).split(path.sep).join('/');
  try {
    await fs.writeFile(absolutePath, parsedUpload.bytes, { flag: 'wx', mode: 0o600 });
    const createdAt = timestamp();
    executeTransaction(db, () => {
      run(db, `INSERT INTO source_files(id, project_id, uploaded_by, file_name, storage_path, mime_type, size_bytes, sha256, extracted_text, parser_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        sourceFileId, project.id, user.id, parsedUpload.filename, relativePath, parsedUpload.mimeType,
        parsedUpload.bytes.length, parsedUpload.sha256, parsedUpload.text, parsedUpload.parserStatus, createdAt,
      ]);
      const sceneRows = new Map();
      for (const scene of parsed.scenes) {
        const sceneId = id();
        run(db, `INSERT OR IGNORE INTO scenes(id, project_id, source_file_id, stable_id, scene_number, heading, line_start, line_end, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          sceneId, project.id, sourceFileId, scene.stableId, scene.sceneNumber, scene.heading, scene.lineStart, scene.lineEnd, createdAt,
        ]);
        const row = one(db, 'SELECT id FROM scenes WHERE project_id = ? AND stable_id = ?', [project.id, scene.stableId]);
        sceneRows.set(scene.stableId, row?.id || sceneId);
      }
      for (const segment of parsed.segments) {
        const segmentId = id();
        run(db, `INSERT OR IGNORE INTO segments
          (id, project_id, scene_id, source_file_id, stable_id, ordinal, type, base_type, text, translation, manual_translation, approved, translation_status, speaker, delivery, line_start, line_end, source_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 'pending', ?, ?, ?, ?, ?, ?, ?)`, [
          segmentId, project.id, sceneRows.get(segment.sceneStableId) || null, sourceFileId, segment.stableId,
          segment.ordinal, segment.type, segment.baseType, segment.text, segment.speaker, segment.delivery,
          segment.lineStart, segment.lineEnd, segment.sourceHash, createdAt, createdAt,
        ]);
      }
      addCharactersAndRelationships(db, project.id, parsed);
      run(db, 'UPDATE projects SET status = ?, updated_at = ? WHERE id = ?', ['in_progress', createdAt, project.id]);
    });
  } catch (error) {
    try { await fs.unlink(absolutePath); } catch { /* file may not have been written */ }
    throw error;
  }
  return {
    sourceFile: sourceFileFromRow(one(db, 'SELECT * FROM source_files WHERE id = ?', [sourceFileId])),
    parsed,
    segmentCount: parsed.segments.length,
    sceneCount: parsed.scenes.length,
  };
}

export function providerConfig(env = process.env) {
  return {
    provider: String(env.CINEVERSE_AI_PROVIDER || '').trim().toLowerCase(),
    baseUrl: String(env.CINEVERSE_AI_BASE_URL || '').trim().replace(/\/$/, ''),
    apiKey: String(env.CINEVERSE_AI_API_KEY || '').trim(),
    model: String(env.CINEVERSE_AI_MODEL || '').trim(),
  };
}

function providerUrl(baseUrl) {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

export function validateTranslationResponse(payload) {
  let value = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.translation === 'string') value = payload.translation;
    else if (typeof payload.text === 'string') value = payload.text;
    else if (Array.isArray(payload.choices) && payload.choices[0]?.message?.content !== undefined) value = payload.choices[0].message.content;
  }
  if (Array.isArray(value)) value = value.map(item => typeof item === 'string' ? item : item?.text || '').join('');
  if (typeof value !== 'string') throw new ApiError(502, 'invalid_provider_response', 'The translation provider returned no text content.');
  const text = value.trim();
  if (!text) throw new ApiError(502, 'invalid_provider_response', 'The translation provider returned an empty translation.');
  if (text.length > 20000) throw new ApiError(502, 'invalid_provider_response', 'The translation provider response exceeded the safety limit.');
  return text;
}

export async function openAiCompatibleTranslate({ text, sourceLanguage, targetLanguage, glossary = [], context = null, signal, env = process.env }) {
  const config = providerConfig(env);
  if (!config.baseUrl || !config.apiKey || !config.model) throw new ProviderNotConfiguredError();
  const sourceText = String(text ?? '');
  if (!sourceText.trim()) throw new ApiError(400, 'empty_translation_input', 'The translation input is empty.');
  if (sourceText.length > MAX_TRANSLATION_CHARS) throw new ApiError(413, 'translation_input_too_large', 'The translation input is too large.');
  const glossaryText = glossary.length
    ? `\nUse these glossary terms when applicable:\n${glossary.map(item => `${item.source_term || item.sourceTerm} => ${item.target_term || item.targetTerm}`).join('\n')}`
    : '';
  const prompt = buildLivePrompt({
    text: sourceText,
    sourceLanguage,
    targetLanguage,
    project: context?.project || {},
    context,
  });
  const response = await fetch(providerUrl(config.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
    signal: signal || AbortSignal.timeout(30000),
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
         { role: 'system', content: 'Translate screenplay data. Preserve meaning, order, voice, uncertainty, structure, and delivery. Never invent facts or explanations. Return only the requested text.' },
          { role: 'user', content: `${prompt}${glossaryText}` },
      ],
    }),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const message = data?.error?.message || `Translation provider returned HTTP ${response.status}.`;
    const error = new Error(message);
    error.code = 'provider_error';
    error.status = response.status;
    throw error;
  }
  return { text: validateTranslationResponse(data), provider: 'openai-compatible', model: config.model };
}

function applyGlossary(text, glossary = []) {
  let output = String(text ?? '');
  for (const entry of glossary) {
    const source = String(entry.source_term ?? entry.sourceTerm ?? '').trim();
    const target = String(entry.target_term ?? entry.targetTerm ?? '').trim();
    if (!source || !target) continue;
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = entry.case_sensitive || entry.caseSensitive ? 'g' : 'gi';
    output = output.replace(new RegExp(escaped, flags), target);
  }
  return output;
}

const DEMO_KNOWN_TRANSLATIONS = new Map([
  ['EXT. RIVERSIDE PLATFORM - NIGHT', 'EXT. ANDÉN DEL RÍO - NOCHE'],
  ['Rain needles the empty platform. A departure board flickers between cities that no longer exist.', 'La lluvia golpea el andén vacío. Un panel de salidas parpadea entre ciudades que ya no existen.'],
  ["The last train doesn't wait for anyone.", 'El último tren no espera a nadie.'],
  ['(under her breath)', '(entre dientes)'],
  ['INT. NIGHT OWL DINER - NIGHT', 'INT. CAFÉ BÚHO NOCTURNO - NOCHE'],
  ['The coffee machine coughs. JONAH watches the door in the reflection of a chrome napkin holder.', 'La cafetera tose. JONAH observa la puerta reflejada en un servilletero de cromo.'],
  ['You came back.', 'Has vuelto.'],
  ['I never left.', 'Nunca me fui.'],
  ['EXT. TRAIN YARD - DAWN', 'EXT. PATIO DE TRENES - AMANECER'],
  ['Beyond the chain-link fence, the first light finds the rust on the rails.', 'Al otro lado de la valla, la primera luz descubre el óxido de los rieles.'],
  ['Some places remember us better than we remember them.', 'Algunos lugares nos recuerdan mejor de lo que nosotros los recordamos.'],
  ['INT. COMMUNITY CINEMA - NIGHT', 'INT. CINE COMUNITARIO - NOCHE'],
  ['The first frame is always a promise.', 'El primer fotograma siempre es una promesa.'],
  ['(quietly)', '(en voz baja)'],
  ['You can hear the whole city breathing.', 'Se puede oír respirar a toda la ciudad.'],
  ['Maya checks the projector. A warm beam cuts through the dust.', 'Maya revisa el proyector. Un haz cálido atraviesa el polvo.'],
  ['We should keep this moment.', 'Deberíamos conservar este momento.'],
  ['For everyone who has not found their story yet.', 'Para todos los que aún no han encontrado su historia.'],
  ['CUT TO:', 'CORTE A:'],
  ['EXT. ROOFTOP - DAWN', 'EXT. AZOTEA - AMANECER'],
  ['The skyline opens into a pale gold morning.', 'El horizonte se abre ante una mañana de oro pálido.'],
  ['Hello.', 'Hola.'],
  ['Goodbye.', 'Adiós.'],
]);

// The seeded demo also covers the Hindi dialogue sample used by the local
// upload smoke test. These are illustrative drafts, never auto-approved.
const DEMO_HINDI_TO_EN_TRANSLATIONS = new Map([
  ['कबीर:तू यहाँ क्यों आया है, आरव?', 'Kabir: Why did you come here, Aarav?'],
  ['आरव:सवाल ये नहीं है कि मैं यहाँ क्यों आया हूँ... सवाल ये है कि तूने मेरे साथ ऐसा क्यों किया?', 'Aarav: The question is not why I came here... the question is why you did this to me.'],
  ['कबीर:मैंने जो किया, मजबूरी में किया था।', 'Kabir: I did what I did because I had no choice.'],
  ['आरव:मजबूरी?जिस इंसान के लिए मैंने पूरी दुनिया से लड़ाई की... उसी ने मुझे बेच दिया।', 'Aarav: No choice? The person I fought the whole world for... sold me out.'],
  ['कबीर:तुझे लगता है मुझे अच्छा लगा था?', 'Kabir: You think I enjoyed it?'],
  ['आरव:नहीं।मुझे लगता था तू मेरा दोस्त है।', 'Aarav: No. I thought you were my friend.'],
  ['(कुछ सेकंड की खामोशी)', '(A few seconds of silence)'],
  ['कबीर:तो अब?', 'Kabir: And now?'],
  ['आरव:अब दोस्ती और दुश्मनी में कोई फर्क नहीं बचा।', 'Aarav: There is no difference left between friendship and enmity now.'],
  ['कबीर:तू मुझे मारेगा?', 'Kabir: Are you going to kill me?'],
  ['आरव:नहीं...क्योंकि मौत की सज़ा दुश्मनों को दी जाती है।तुझे तो मैंने कभी अपना माना था।', 'Aarav: No... because the death sentence is for enemies. I once considered you my own.'],
  ['(आरव पीछे मुड़कर चला जाता है। कबीर वहीं खड़ा रह जाता है।)', '(Aarav turns and walks away. Kabir remains standing there.)'],
  ['कबीर:आरव...', 'Kabir: Aarav...'],
  ['(आरव रुकता है, लेकिन पीछे नहीं देखता।)', '(Aarav stops, but does not look back.)'],
  ['कबीर:एक मौका दे दे।', 'Kabir: Give me one chance.'],
  ['आरव:मौका मैं आज भी दे सकता हूँ...लेकिन भरोसा?वो दोबारा नहीं मिलेगा।', 'Aarav: I can still give you a chance... but trust? You will not get it back.'],
]);

const DEMO_SCREENPLAY = `Title: Midnight Train

EXT. RIVERSIDE PLATFORM - NIGHT

Rain needles the empty platform. A departure board flickers between cities that no longer exist.

MARA
The last train doesn't wait for anyone.

(under her breath)

INT. NIGHT OWL DINER - NIGHT

The coffee machine coughs. JONAH watches the door in the reflection of a chrome napkin holder.

JONAH
You came back.

MARA
I never left.

EXT. TRAIN YARD - DAWN

Beyond the chain-link fence, the first light finds the rust on the rails.

MARA (V.O.)
Some places remember us better than we remember them.`;

function demoKnownTranslation(text, sourceLanguage, targetLanguage) {
  const source = String(sourceLanguage || 'en').toLowerCase().split(/[-_]/)[0];
  const target = String(targetLanguage || 'en').toLowerCase().split(/[-_]/)[0];
  const normalized = normalizeText(text).trim();
  if (source === 'en' && target === 'es') return DEMO_KNOWN_TRANSLATIONS.get(normalized) || null;
  if (source === 'hi' && target === 'en') return DEMO_HINDI_TO_EN_TRANSLATIONS.get(normalized) || null;
  return null;
}

function demoEnabled(env) {
  if (env.CINEVERSE_DEMO_ENABLED !== undefined) return parseBoolean(env.CINEVERSE_DEMO_ENABLED, false);
  return String(env.NODE_ENV || '').toLowerCase() !== 'production';
}

async function seedDemoProject({ db, user, storageDir, maxBytes }) {
  const projectId = id();
  const at = timestamp();
  executeTransaction(db, () => {
    run(db, `INSERT INTO projects(id, owner_id, title, description, source_language, target_language,
      translation_mode, context_depth, custom_instructions, adaptation, demo, status, created_at, updated_at)
      VALUES (?, ?, 'Midnight Train', ?, 'en', 'es', 'cinematic', 'deep', ?, 'functional', 1, 'in_progress', ?, ?)`, [
      projectId, user.id,
      'A quiet supernatural drama about a conductor, a vanished sister, and one impossible timetable.',
      'Keep the supernatural understated and preserve the film’s quiet cadence.', at, at,
    ]);
    run(db, 'INSERT INTO memberships(project_id, user_id, role, created_at) VALUES (?, ?, \'owner\', ?)', [projectId, user.id, at]);
  });
  try {
    await persistUpload({ db, project: { id: projectId }, user, upload: { filename: 'midnight-train.fountain', data: DEMO_SCREENPLAY }, storageDir, maxBytes });
    const rows = many(db, 'SELECT * FROM segments WHERE project_id = ? ORDER BY ordinal', [projectId]);
    for (const segment of rows) {
      const translated = segment.type === 'character'
        ? segment.text
        : demoKnownTranslation(segment.text, 'en', 'es');
      if (!translated) continue;
      const approved = ['scene_heading', 'character', 'action'].includes(segment.type) ? 1 : 0;
      run(db, `UPDATE segments SET translation = ?, translation_status = 'translated', approved = ?, updated_at = ? WHERE id = ?`, [translated, approved, at, segment.id]);
      run(db, `INSERT INTO translation_versions(id, project_id, segment_id, source_text, translated_text, provider, model, created_by, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'demo-seed', 'midnight-train-v1', ?, 'accepted', ?)`, [id(), projectId, segment.id, segment.text, translated, user.id, at]);
    }
    const chars = [
      ['Mara', { role: 'Protagonist', description: 'A former conductor returning to the platform where her sister disappeared.', voice: 'Economical, observant, avoids naming grief.', tags: ['restrained', 'precise'], relation: 'Sister of Elise · history with Jonah' }],
      ['Jonah', { role: 'Station keeper', description: 'Keeps the Night Owl open after the final train, waiting for a promise to resolve.', voice: 'Warm understatement with a dry edge.', tags: ['grounded', 'wry'], relation: 'Old friend · knows the timetable' }],
      ['Elise', { role: 'Absent sister', description: 'Present through memory, artifacts, and the train’s impossible announcements.', voice: 'Bright, curious, fragmentary.', tags: ['memory', 'mystery'], relation: 'Mara’s sister · unseen in present tense' }],
    ];
    for (const [name, metadata] of chars) {
      const existing = one(db, 'SELECT id FROM characters WHERE project_id = ? AND normalized_name = ?', [projectId, name.toLocaleLowerCase()]);
      if (existing) run(db, 'UPDATE characters SET metadata_json = ? WHERE id = ?', [JSON.stringify(metadata), existing.id]);
      else run(db, `INSERT INTO characters(id, project_id, name, normalized_name, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [id(), projectId, name, name.toLocaleLowerCase(), JSON.stringify(metadata), at]);
    }
    const sceneRows = many(db, 'SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number', [projectId]);
    const glossary = [
      ['last train', 'último tren', 'Terminology', null, 'Use consistently in timetable references.'],
      ['platform', 'andén', 'Terminology', null, 'Avoid “plataforma” in station directions.'],
      ['Night Owl', 'Búho Nocturno', 'Character voice', sceneRows[1]?.id || null, 'Proper name of the diner; keep title case.'],
    ];
    for (const [source, target, category, sceneId, notes] of glossary) run(db, `INSERT OR IGNORE INTO glossary_entries(id, project_id, source_term, target_term, notes, case_sensitive, category, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id(), projectId, source, target, notes, source === 'Night Owl' ? 1 : 0, category, sceneId, at, at]);
    const memories = [
      ['The supernatural remains understated.', 'Lo sobrenatural permanece sutil.', 'Keep the unease in what is not said.', null],
      ['The last train', 'el último tren', 'Timetable terminology.', sceneRows[0]?.id || null],
    ];
    for (const [sourceText, targetText, note, sceneId] of memories) run(db, 'INSERT INTO context_memories(id, project_id, source_text, target_text, note, scene_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id(), projectId, sourceText, targetText, note, sceneId, user.id, at]);
    updateProjectTimestamp(db, projectId);
    return projectId;
  } catch (error) {
    run(db, 'DELETE FROM projects WHERE id = ?', [projectId]);
    throw error;
  }
}

/**
 * Deliberately non-production translation used only when explicitly enabled.
 * The response carries `demo: true` and a stable provider name so callers can
 * never mistake this deterministic pass for an AI translation.
 */
export async function demoTranslate({ text, glossary = [], sourceLanguage = 'en', targetLanguage = 'en', alternative = false, segment = null }) {
  const source = String(text ?? '');
  const known = demoKnownTranslation(source, sourceLanguage, targetLanguage);
  const glossaryText = applyGlossary(source, glossary);
  const sourceCode = String(sourceLanguage || 'en').toLowerCase().split(/[-_]/)[0];
  const targetCode = String(targetLanguage || 'en').toLowerCase().split(/[-_]/)[0];
  const supportedDemoPair = (sourceCode === 'en' && targetCode === 'es') || (sourceCode === 'hi' && targetCode === 'en' && Boolean(known));
  const primary = known || (sourceCode === 'en' && targetCode === 'es'
    ? deterministicDemoTranslation(source, { glossary, segment })
    : glossaryText);
  const knownAlternatives = source === "The last train doesn't wait for anyone." && known
    ? ['El último tren no se detiene por nadie.']
    : [];
  const translated = alternative && knownAlternatives.length ? knownAlternatives[0] : primary;
  const untranslated = !supportedDemoPair && !known;
  const warning = supportedDemoPair
    ? DEMO_TRANSLATION_WARNING
    : untranslated
      ? (glossaryText !== source
        ? 'Only glossary replacements were applied; this is not a full translation and requires human review.'
        : untranslatedWarning(source, sourceLanguage, targetLanguage))
      : null;
  const alternatives = alternative && !untranslated ? [primary] : knownAlternatives;
  return {
    text: translated,
    provider: 'demo-fallback',
    model: 'deterministic-demo-v1',
    demo: true,
    targetLanguage,
    untranslated,
    warnings: warning ? [warning] : [],
    alternatives,
  };
}

/**
 * Provider-agnostic AI service boundary. Applications can inject a function
 * or `{ translate() }` adapter; otherwise the built-in OpenAI-compatible
 * adapter is selected. Deterministic fallback is opt-in only.
 */
export function createAiService({ env = process.env, adapter = null, allowDemoFallback = undefined } = {}) {
  const config = providerConfig(env);
  const injected = typeof adapter === 'function' ? adapter : adapter?.translate;
  if (injected) {
    return {
      provider: adapter.provider || 'custom',
      model: adapter.model || null,
      demo: Boolean(adapter.demo),
      async translate(input) {
        const result = await injected(input);
        return typeof result === 'string' ? { text: result, provider: adapter.provider || 'custom', model: adapter.model || null } : result;
      },
    };
  }
  const demoEnabled = allowDemoFallback === undefined
    ? parseBoolean(env.CINEVERSE_AI_ALLOW_DEMO_FALLBACK, false) || config.provider === 'demo' || config.provider === 'deterministic-demo'
    : Boolean(allowDemoFallback);
  const developmentDefault = String(env.NODE_ENV || '').toLowerCase() !== 'production'
    && !config.provider && !config.baseUrl && !config.apiKey && !config.model;
  if (config.provider === 'demo' || config.provider === 'deterministic-demo' || (demoEnabled && !config.baseUrl && !config.apiKey && !config.model) || developmentDefault) {
    return { provider: 'demo-fallback', model: 'deterministic-demo-v1', demo: true, translate: demoTranslate };
  }
  return {
    provider: 'openai-compatible',
    model: config.model || null,
    demo: false,
    translate: (input) => openAiCompatibleTranslate({ ...input, env }),
  };
}

export function aiServiceStatus({ env = process.env, adapter = null, service: suppliedService = null, allowDemoFallback = undefined } = {}) {
  const config = providerConfig(env);
  const service = suppliedService || createAiService({ env, adapter, allowDemoFallback });
  return {
    provider: service.provider,
    model: service.model,
    configured: Boolean(suppliedService || adapter || service.demo || (config.baseUrl && config.apiKey && config.model)),
    demoFallback: Boolean(service.demo),
  };
}

function translationTextFromAdapterResult(result) {
  return validateTranslationResponse(result);
}

function normalizedConfidence(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return clamp(number > 1 ? number / 100 : number, 0, 1);
}

function suggestionFromResult(result, source, currentTranslation, alternative = false) {
  let payload = result;
  const candidate = result?.text ?? result?.choices?.[0]?.message?.content;
  if (typeof candidate === 'string' && /^\s*\{/.test(candidate)) {
    try { payload = { ...result, ...JSON.parse(candidate) }; } catch { /* plain provider text is handled below */ }
  }
  const translation = translationTextFromAdapterResult(payload);
  const providedAlternatives = Array.isArray(payload?.alternatives)
    ? payload.alternatives.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 3)
    : [];
  const alternatives = [...new Set(providedAlternatives.filter(item => item !== translation && item !== source))];
  if (alternative && !alternatives.length && translation !== currentTranslation && translation !== source) alternatives.push(translation);
  const warnings = Array.isArray(result?.warnings) ? result.warnings.map(item => String(item)).slice(0, 10) : [];
  return {
    translation,
    alternatives,
    confidence: normalizedConfidence(payload?.confidence, payload?.demo ? (payload?.untranslated ? null : 0.84) : null),
    demo: Boolean(payload?.demo),
    untranslated: Boolean(payload?.untranslated),
    warnings,
  };
}

export async function runTranslationJob({ db, jobId, project, user, aiAdapter = null, aiService = null, env = process.env, allowDemoFallback = undefined, signal = null }) {
  const job = one(db, 'SELECT * FROM processing_jobs WHERE id = ?', [jobId]);
  if (!job || !JOB_STATUSES.has(job.status)) return;
  const started = run(db, `UPDATE processing_jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`, [timestamp(), timestamp(), jobId]);
  if (!started.changes) return;
  const request = JSON.parse(job.result_json || '{}');
  const segmentIds = Array.isArray(request.segmentIds) ? request.segmentIds : [];
  const service = aiService || createAiService({ env, adapter: aiAdapter, allowDemoFallback });
  const startedAtMs = Date.now();
  try {
    const currentProject = one(db, 'SELECT * FROM projects WHERE id = ?', [project.id]);
    const glossary = many(db, 'SELECT * FROM glossary_entries WHERE project_id = ? ORDER BY source_term', [project.id]);
    let completed = 0;
    const results = [];
    for (const segmentId of segmentIds) {
      const state = one(db, 'SELECT status, cancel_requested FROM processing_jobs WHERE id = ?', [jobId]);
      if (!state || state.cancel_requested || state.status === 'cancelled') {
        run(db, `UPDATE processing_jobs SET status = 'cancelled', error_code = 'cancelled', error_message = 'Translation was cancelled before all segments completed.', completed_at = ?, updated_at = ? WHERE id = ?`, [timestamp(), timestamp(), jobId]);
        return;
      }
      const segment = rowForSegment(db, project.id, segmentId);
      if (!segment) {
        results.push({ segmentId, skipped: true, reason: 'segment_not_found' });
        completed += 1;
        continue;
      }
      if (segment.manual_translation !== null && segment.manual_translation !== undefined) {
        results.push({ segmentId: segment.id, skipped: true, reason: 'manual_translation_protected' });
        completed += 1;
        run(db, 'UPDATE processing_jobs SET progress = ?, updated_at = ? WHERE id = ?', [Math.round((completed / segmentIds.length) * 100), timestamp(), jobId]);
        continue;
      }
      if (segment.approved) {
        results.push({ segmentId: segment.id, skipped: true, reason: 'approved_translation_protected' });
        completed += 1;
        run(db, 'UPDATE processing_jobs SET progress = ?, updated_at = ? WHERE id = ?', [Math.round((completed / segmentIds.length) * 100), timestamp(), jobId]);
        continue;
      }
      if (segment.text.length > MAX_TRANSLATION_CHARS) throw new ApiError(413, 'translation_input_too_large', 'A screenplay segment is too large for translation.');
      const segmentGlossary = glossary.filter(entry => !entry.scene_id || entry.scene_id === segment.scene_id)
        .sort((a, b) => Number(Boolean(b.scene_id)) - Number(Boolean(a.scene_id)));
      const translationSignal = typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30000)])
        : (signal || AbortSignal.timeout(30000));
      const result = await service.translate({
         text: segment.text,
         sourceLanguage: currentProject.source_language,
         targetLanguage: currentProject.target_language,
          glossary: segmentGlossary,
          context: contextForSegment(db, project.id, segment),
         segment,
          signal: translationSignal,
         env,
       });
       const translated = translationTextFromAdapterResult(result);
       if (result?.untranslated && service.demo) {
         results.push({ segmentId: segment.id, skipped: true, reason: 'demo_untranslated', untranslated: true, warnings: result.warnings || [untranslatedWarning(segment.text, currentProject.source_language, currentProject.target_language)] });
         completed += 1;
         run(db, 'UPDATE segments SET translation_status = \'pending\', updated_at = ? WHERE id = ? AND project_id = ? AND manual_translation IS NULL', [timestamp(), segment.id, project.id]);
         run(db, 'UPDATE processing_jobs SET progress = ?, updated_at = ? WHERE id = ?', [Math.round((completed / segmentIds.length) * 100), timestamp(), jobId]);
         continue;
       }
       const latestBeforeWrite = rowForSegment(db, project.id, segment.id);
       if (!latestBeforeWrite || latestBeforeWrite.manual_translation !== null || latestBeforeWrite.approved) {
         results.push({ segmentId: segment.id, skipped: true, reason: latestBeforeWrite?.approved ? 'approved_translation_protected' : 'manual_translation_protected' });
         completed += 1;
         run(db, 'UPDATE processing_jobs SET progress = ?, updated_at = ? WHERE id = ?', [Math.round((completed / segmentIds.length) * 100), timestamp(), jobId]);
         continue;
        }
        const changedAt = timestamp();
        let persisted = false;
        executeTransaction(db, () => {
          const latest = rowForSegment(db, project.id, segment.id);
          if (!latest || (latest.manual_translation !== null && latest.manual_translation !== undefined) || latest.approved) return;
          const updated = run(db, `UPDATE segments SET translation = ?, translation_status = 'translated', updated_at = ? WHERE id = ? AND project_id = ? AND manual_translation IS NULL AND approved = 0`, [translated, changedAt, segment.id, project.id]);
          if (!updated.changes) return;
          run(db, `INSERT INTO translation_versions(id, project_id, segment_id, source_text, translated_text, provider, model, created_by, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`, [
            id(), project.id, segment.id, segment.text, translated,
            typeof result === 'object' && result?.provider ? result.provider : 'openai-compatible',
            typeof result === 'object' ? result.model || null : null, user.id, changedAt,
          ]);
          persisted = true;
        });
       completed += 1;
        if (persisted) {
          results.push({
            segmentId: segment.id,
            translated: true,
            provider: result?.provider || service.provider,
            demo: Boolean(result?.demo || service.demo),
            warnings: Array.isArray(result?.warnings) ? result.warnings : [],
          });
        } else {
          results.push({ segmentId: segment.id, skipped: true, reason: 'translation_protected' });
        }
      run(db, 'UPDATE processing_jobs SET progress = ?, updated_at = ? WHERE id = ?', [Math.round((completed / segmentIds.length) * 100), timestamp(), jobId]);
    }
      const warnings = [...new Set(results.flatMap(item => Array.isArray(item.warnings) ? item.warnings : []))];
      run(db, `UPDATE processing_jobs SET status = 'completed', progress = 100, result_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [JSON.stringify({ results, warnings, provider: service.provider, model: service.model, demoFallback: Boolean(service.demo), elapsedMs: Math.max(0, Date.now() - startedAtMs) }), timestamp(), timestamp(), jobId]);
  } catch (error) {
    const current = one(db, 'SELECT status, cancel_requested FROM processing_jobs WHERE id = ?', [jobId]);
    if (current?.status === 'cancelled' || current?.cancel_requested) {
      run(db, `UPDATE processing_jobs SET status = 'cancelled', error_code = 'cancelled', error_message = 'Translation was cancelled.', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?`, [timestamp(), timestamp(), jobId]);
      return;
    }
    const code = error?.code || 'translation_failed';
    const message = error instanceof ProviderNotConfiguredError
      ? error.message
      : String(error?.message || 'Translation failed.').slice(0, 1000);
    run(db, `UPDATE processing_jobs SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [code, message, timestamp(), timestamp(), jobId]);
  }
}

function placeholderTokens(text) {
  const tokens = [];
  const source = String(text ?? '');
  for (const match of source.matchAll(/\{\{[^}]+\}\}|\[[A-Z][A-Z0-9 _-]{1,60}\]|%[sd]/g)) tokens.push(match[0]);
  return tokens;
}

export function validateProject(db, projectId, options = {}) {
  const segmentIds = Array.isArray(options.segmentIds) && options.segmentIds.length
    ? options.segmentIds
    : null;
  const segments = segmentIds
    ? many(db, `SELECT s.*, CASE WHEN s.type = 'dialogue' AND s.delivery != 'on_screen' THEN s.delivery ELSE s.type END AS segment_type
      FROM segments s WHERE s.project_id = ? AND (s.id IN (${segmentIds.map(() => '?').join(',')}) OR s.stable_id IN (${segmentIds.map(() => '?').join(',')}))`, [projectId, ...segmentIds, ...segmentIds])
    : many(db, `SELECT s.*, CASE WHEN s.type = 'dialogue' AND s.delivery != 'on_screen' THEN s.delivery ELSE s.type END AS segment_type
      FROM segments s WHERE s.project_id = ? ORDER BY s.ordinal`, [projectId]);
  const glossary = many(db, 'SELECT * FROM glossary_entries WHERE project_id = ?', [projectId]);
  const ignoredIssues = new Set(many(db, `SELECT segment_id, code FROM validation_issues WHERE project_id = ? AND source = 'review_ignore' AND resolved = 1`, [projectId]).map(row => `${row.segment_id || ''}:${row.code}`));
  const issues = [];
  const add = (segment, severity, code, message, category = 'Terminology', source = 'deterministic') => {
    if (source !== 'review_ignore' && ignoredIssues.has(`${segment?.id || ''}:${code}`)) return;
    issues.push({
    id: id(), projectId, segmentId: segment?.id || null, severity, code, category, message, resolved: false, source, createdAt: timestamp(),
    });
  };
  for (const segment of segments) {
    const translated = segment.manual_translation ?? segment.translation;
    const isTranslatable = ['dialogue', 'parenthetical', 'action', 'voice_over', 'off_screen'].includes(segment.segment_type || segment.type);
    if (isTranslatable && !String(translated ?? '').trim()) add(segment, 'error', 'missing_translation', 'This segment has no translation.', 'Meaning');
    if (translated && !segment.manual_translation && segment.translation_status !== 'translated') add(segment, 'warning', 'translation_status_unconfirmed', 'A translation exists but is not marked as translated.', 'Formatting');
    if (translated && !segment.approved) add(segment, 'warning', 'not_approved', 'Translation is not approved for export.', 'Meaning');
    const sourceTokens = placeholderTokens(segment.text);
    const targetTokens = placeholderTokens(translated || '');
    for (const token of sourceTokens) if (!targetTokens.includes(token)) add(segment, 'warning', 'placeholder_changed', `Placeholder ${token} is missing from the translation.`, 'Formatting');
    if (translated && segment.text.length > 20 && String(translated).length > segment.text.length * 4) {
      add(segment, 'warning', 'length_outlier', 'The translation is unusually longer than its source segment.', 'Meaning');
    }
    if (translated && /[([{]$/.test(segment.text.trim()) && !/[([{]/.test(translated)) {
      add(segment, 'warning', 'punctuation_changed', 'Opening punctuation may have been lost in the translation.', 'Formatting');
    }
    for (const entry of glossary.filter(item => !item.scene_id || item.scene_id === segment.scene_id)) {
      const sourceHas = entry.case_sensitive
        ? segment.text.includes(entry.source_term)
        : segment.text.toLocaleLowerCase().includes(entry.source_term.toLocaleLowerCase());
      const targetHas = entry.case_sensitive
        ? String(translated || '').includes(entry.target_term)
        : String(translated || '').toLocaleLowerCase().includes(entry.target_term.toLocaleLowerCase());
      if (sourceHas && translated && !targetHas) add(segment, 'warning', 'glossary_mismatch', `Glossary term “${entry.source_term}” is not represented by “${entry.target_term}”.`, entry.category || 'Terminology');
    }
    if (translated) {
      for (const caution of semanticCautions(segment.text, translated, glossary.filter(item => !item.scene_id || item.scene_id === segment.scene_id))) {
        if (caution.code === 'glossary_mismatch' && issues.some(issue => issue.segmentId === segment.id && issue.code === caution.code)) continue;
        add(segment, 'warning', caution.code, caution.message, caution.category, 'heuristic');
      }
    }
  }
  executeTransaction(db, () => {
      if (segmentIds) {
       for (const segment of segments) run(db, `DELETE FROM validation_issues WHERE project_id = ? AND source IN ('deterministic', 'heuristic') AND segment_id = ?`, [projectId, segment.id]);
    } else run(db, `DELETE FROM validation_issues WHERE project_id = ? AND source IN ('deterministic', 'heuristic')`, [projectId]);
    for (const issue of issues) run(db, `INSERT INTO validation_issues(id, project_id, segment_id, severity, code, category, message, resolved, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, [issue.id, projectId, issue.segmentId, issue.severity, issue.code, issue.category, issue.message, issue.source, issue.createdAt]);
  });
  return issues;
}

function validationIssueFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentId: row.segment_id,
    severity: row.severity,
    code: row.code,
    category: row.category || 'Terminology',
    message: row.message,
    resolved: Boolean(row.resolved),
    source: row.source,
    createdAt: row.created_at,
  };
}

function csvCell(value) {
  const raw = String(value ?? '');
  const text = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function warningMetadata(db, projectId) {
  const rows = many(db, `SELECT severity, COUNT(*) AS count FROM validation_issues WHERE project_id = ? AND resolved = 0 GROUP BY severity`, [projectId]);
  const bySeverity = Object.fromEntries(rows.map(row => [row.severity, Number(row.count)]));
  return { count: rows.reduce((sum, row) => sum + Number(row.count), 0), bySeverity };
}

export function exportProject(db, projectId, format) {
  const project = one(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) throw new ApiError(404, 'project_not_found', 'Project not found.');
  const scenes = many(db, 'SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number', [projectId]);
  const segments = many(db, `SELECT s.*, CASE WHEN s.type = 'dialogue' AND s.delivery != 'on_screen' THEN s.delivery ELSE s.type END AS segment_type
    FROM segments s WHERE s.project_id = ? ORDER BY s.ordinal`, [projectId]);
  const glossary = many(db, 'SELECT * FROM glossary_entries WHERE project_id = ? ORDER BY source_term', [projectId]);
  const memories = many(db, 'SELECT * FROM context_memories WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  const warnings = warningMetadata(db, projectId);
  const normalizedFormat = String(format || 'json').trim().toLowerCase();
  const translationFor = (segment) => {
    const value = segment.manual_translation ?? segment.translation;
    return value !== null && value !== undefined && String(value).trim() ? String(value) : `UNTRANSLATED — ${segment.text}`;
  };
  if (normalizedFormat === 'json') {
    return {
      contentType: 'application/json; charset=utf-8',
      extension: 'json',
      content: JSON.stringify({
        metadata: { exportedAt: timestamp(), projectId, title: project.title, warningCount: warnings.count, warnings },
        project: projectFromRow(project),
        scenes: scenes.map(sceneFromRow),
        segments: segments.map(segmentFromRow),
        glossary: glossary.map(glossaryFromRow),
        memories: memories.map(memoryFromRow),
        warnings: many(db, 'SELECT * FROM validation_issues WHERE project_id = ? AND resolved = 0 ORDER BY severity, created_at', [projectId]).map(validationIssueFromRow),
      }, null, 2),
    };
  }
  if (normalizedFormat === 'docx') return exportDocx({ project, segments, warnings });
  if (normalizedFormat === 'fdx') return exportFdx({ project, segments, warnings });
  if (normalizedFormat === 'fountain') return exportFountain({ project, segments, warnings });
  if (normalizedFormat === 'txt' || normalizedFormat === 'text' || normalizedFormat === 'plain' || normalizedFormat === 'md') {
    const output = exportScreenplayText({ project, segments, warnings });
    return { ...output, contentType: normalizedFormat === 'md' ? 'text/markdown; charset=utf-8' : output.contentType, extension: normalizedFormat === 'md' ? 'md' : 'txt' };
  }
  if (normalizedFormat === 'csv' || normalizedFormat === 'glossary.csv' || normalizedFormat === 'glossary') {
    const rows = [['source_term', 'target_term', 'notes', 'case_sensitive', 'category', 'scene_id']];
    for (const entry of glossary) rows.push([entry.source_term, entry.target_term, entry.notes, entry.case_sensitive ? 'true' : 'false', entry.category || 'Terminology', entry.scene_id || '']);
    return { contentType: 'text/csv; charset=utf-8', extension: 'csv', content: `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n` };
  }
  if (normalizedFormat === 'review') {
    const issues = many(db, `SELECT * FROM validation_issues WHERE project_id = ? AND resolved = 0 ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END, created_at`, [projectId]);
    const lines = [`CINEVERSE REVIEW NOTES — ${project.title}`, `Generated: ${timestamp()}`, `Open issues: ${issues.length}`, ''];
    for (const issue of issues) {
      const segment = issue.segment_id ? one(db, 'SELECT * FROM segments WHERE id = ? AND project_id = ?', [issue.segment_id, projectId]) : null;
      lines.push(`[${String(issue.severity).toUpperCase()}] ${issue.code}`, issue.message);
      if (segment) lines.push(`Source: ${segment.text}`, `Target: ${segment.manual_translation ?? segment.translation ?? '—'}`);
      lines.push('');
    }
    return { contentType: 'text/plain; charset=utf-8', extension: 'txt', content: `${lines.join('\n')}\n` };
  }
  throw new ApiError(400, 'unsupported_export_format', 'Supported export formats are json, txt, fountain, fdx, docx, md, csv, and review.');
}

async function readRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'request_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new ApiError(400, 'invalid_multipart', 'Multipart uploads must include a boundary.');
  const boundaryText = boundaryMatch[1] || boundaryMatch[2].trim();
  if (!boundaryText || boundaryText.length > 200 || /[^\x20-\x7e]/.test(boundaryText)) {
    throw new ApiError(400, 'invalid_multipart', 'The multipart boundary is invalid.');
  }
  const boundary = Buffer.from(`--${boundaryText}`);
  const parts = {};
  let partCount = 0;
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor);
    if (start < 0) break;
    const contentStart = start + boundary.length;
    if (buffer.subarray(contentStart, contentStart + 2).toString() === '--') break;
    const headerStart = contentStart + (buffer.subarray(contentStart, contentStart + 2).toString() === '\r\n' ? 2 : 0);
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;
    const headers = buffer.subarray(headerStart, headerEnd).toString('utf8');
    const nextBoundary = buffer.indexOf(boundary, headerEnd + 4);
    if (nextBoundary < 0) break;
    let dataEnd = nextBoundary;
    if (buffer.subarray(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
    const disposition = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (disposition) {
       partCount += 1;
       if (partCount > 32) throw new ApiError(400, 'invalid_multipart', 'Multipart requests contain too many parts.');
       const name = disposition[1];
      const filename = disposition[2];
      const type = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'text/plain';
      const value = buffer.subarray(headerEnd + 4, dataEnd);
      if (filename !== undefined) parts.file = { filename, name: filename, mimeType: type, data: Buffer.from(value) };
      else parts[name] = value.toString('utf8');
    }
    cursor = nextBoundary + boundary.length;
  }
  return parts;
}

async function parseRequestBody(req, maxBytes = MAX_BODY_BYTES) {
  const raw = await readRequestBody(req, maxBytes);
  if (!raw.length) return { body: {}, raw };
  const rawContentType = String(req.headers['content-type'] || '');
  const contentType = rawContentType.toLowerCase();
  if (contentType.includes('multipart/form-data')) return { body: parseMultipart(raw, rawContentType), raw };
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try { return { body: JSON.parse(raw.toString('utf8')), raw }; }
    catch { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.'); }
  }
  if (contentType.startsWith('text/')) return { body: { text: raw.toString('utf8') }, raw };
  return { body: {}, raw };
}

function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(text);
}

function sendError(res, error) {
  const code = error?.code || 'internal_error';
  const status = code === 'provider_not_configured' ? 503 : code === 'provider_error' || code === 'invalid_provider_response' ? 502 : Number(error?.status) || 500;
  const payload = { error: code, code, message: error?.message || 'An unexpected server error occurred.' };
  if (error?.details !== undefined) payload.details = error.details;
  if (status >= 500) console.error(error);
  sendJson(res, status, payload);
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed', message: `Use ${allow}.` });
}

function parsePath(pathname) {
  return pathname.split('/').filter(Boolean).map(item => decodeURIComponent(item));
}

function jsonBodyValue(body, ...keys) {
  for (const key of keys) if (body && body[key] !== undefined) return body[key];
  return undefined;
}

function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  return body;
}

function textField(value, name, { required = false, max = 1000, fallback = '' } = {}) {
  const text = value === undefined || value === null ? fallback : String(value).trim();
  if (required && !text) throw new ApiError(400, `invalid_${name}`, `${name} is required.`);
  if (text.length > max) throw new ApiError(400, `invalid_${name}`, `${name} must be ${max} characters or fewer.`);
  return text;
}

function safeLanguage(value, name, fallback = 'en') {
  const language = String(value ?? fallback).trim().toLowerCase();
  if (!/^(?:auto|[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?)$/.test(language)) {
    throw new ApiError(400, `invalid_${name}`, `${name} must be a valid language code.`);
  }
  return language;
}

function idList(value, name = 'segmentIds', max = JOB_MAX_SEGMENTS) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new ApiError(400, `invalid_${name}`, `${name} must be an array.`);
  const result = [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))];
  if (result.length > max) throw new ApiError(413, `${name}_too_large`, `${name} may contain at most ${max} items.`);
  if (result.some(item => item.length > 200)) throw new ApiError(400, `invalid_${name}`, `${name} contains an invalid identifier.`);
  return result;
}

function sqliteConflict(error) {
  return /unique constraint|constraint failed/i.test(String(error?.message || ''));
}

function updateProjectTimestamp(db, projectId) {
  run(db, 'UPDATE projects SET updated_at = ? WHERE id = ?', [timestamp(), projectId]);
}

function parseMetadata(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function characterFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  };
}

function relationshipFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    characterAId: row.character_a_id,
    characterBId: row.character_b_id,
    characterA: row.character_a,
    characterB: row.character_b,
    relationshipType: row.relationship_type,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function annotationFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentId: row.segment_id,
    annotationType: row.annotation_type,
    value: row.value,
    source: row.source,
    createdAt: row.created_at,
  };
}

function expressionFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentId: row.segment_id,
    expression: row.expression,
    explanation: row.explanation,
    suggestedTranslation: row.suggested_translation,
    createdAt: row.created_at,
  };
}

function decisionFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentId: row.segment_id,
    userId: row.user_id,
    decision: row.decision,
    note: row.note,
    createdAt: row.created_at,
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentId: row.segment_id,
    userId: row.user_id,
    authorName: row.author_name,
    body: row.body,
    resolved: Boolean(row.resolved),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function evaluationFromRow(row) {
  let metrics = {};
  try { metrics = JSON.parse(row.metrics_json || '{}'); } catch { metrics = {}; }
  return { id: row.id, projectId: row.project_id, userId: row.user_id, status: row.status, metrics, createdAt: row.created_at, completedAt: row.completed_at };
}

function listProjectRows(db, userId) {
  return many(db, `SELECT p.*, m.role,
      (SELECT COUNT(*) FROM segments s WHERE s.project_id = p.id) AS segment_count,
      (SELECT COUNT(*) FROM segments s WHERE s.project_id = p.id AND COALESCE(s.manual_translation, s.translation) IS NOT NULL AND COALESCE(s.manual_translation, s.translation) != '') AS translated_count,
      (SELECT COUNT(*) FROM segments s WHERE s.project_id = p.id AND s.approved = 1) AS approved_count,
      (SELECT COUNT(*) FROM validation_issues v WHERE v.project_id = p.id AND v.resolved = 0) AS issue_count
    FROM projects p JOIN memberships m ON m.project_id = p.id AND m.user_id = ?
    ORDER BY p.updated_at DESC`, [userId]).map(projectFromRow);
}

function projectBundle(db, projectId, includeSourceText = false) {
  const project = one(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!project) throw new ApiError(404, 'project_not_found', 'Project not found.');
  const stats = projectStats(db, projectId);
  const sourceFiles = many(db, 'SELECT * FROM source_files WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(row => {
    const value = sourceFileFromRow(row);
    if (includeSourceText) value.extractedText = row.extracted_text;
    return value;
  });
  const scenes = many(db, 'SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number', [projectId]).map(sceneFromRow);
  const segments = many(db, `SELECT s.*, CASE WHEN s.type = 'dialogue' AND s.delivery != 'on_screen' THEN s.delivery ELSE s.type END AS segment_type
    FROM segments s WHERE s.project_id = ? ORDER BY s.ordinal`, [projectId]).map(segmentFromRow);
  const characters = many(db, 'SELECT * FROM characters WHERE project_id = ? ORDER BY normalized_name', [projectId]).map(characterFromRow);
  const relationships = many(db, `SELECT r.*, a.name AS character_a, b.name AS character_b
    FROM character_relationships r JOIN characters a ON a.id = r.character_a_id JOIN characters b ON b.id = r.character_b_id
    WHERE r.project_id = ? ORDER BY r.created_at`, [projectId]).map(relationshipFromRow);
  const annotations = many(db, 'SELECT * FROM context_annotations WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(annotationFromRow);
  const culturalExpressions = many(db, 'SELECT * FROM cultural_expressions WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(expressionFromRow);
  const glossary = many(db, 'SELECT * FROM glossary_entries WHERE project_id = ? ORDER BY source_term', [projectId]).map(glossaryFromRow);
  const memories = many(db, 'SELECT * FROM context_memories WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(memoryFromRow);
  const issues = many(db, 'SELECT * FROM validation_issues WHERE project_id = ? AND resolved = 0 ORDER BY CASE severity WHEN \'error\' THEN 0 ELSE 1 END, created_at', [projectId]).map(validationIssueFromRow);
  const statsView = {
    segmentCount: Number(stats?.segment_count || 0),
    translatedCount: Number(stats?.translated_count || 0),
    approvedCount: Number(stats?.approved_count || 0),
    issueCount: Number(stats?.issue_count || 0),
  };
  return { project: { ...projectFromRow(project), ...statsView }, sourceFiles, scenes, segments, characters, relationships, annotations, culturalExpressions, glossary, memories, validationIssues: issues };
}

function resolveSegment(db, projectId, segmentId) {
  const row = rowForSegment(db, projectId, String(segmentId));
  if (!row) throw new ApiError(404, 'segment_not_found', 'Segment not found in this project.');
  return row;
}

function resolveScene(db, projectId, sceneId) {
  const row = one(db, 'SELECT * FROM scenes WHERE project_id = ? AND (id = ? OR stable_id = ?)', [projectId, sceneId, sceneId]);
  if (!row) throw new ApiError(404, 'scene_not_found', 'Scene not found in this project.');
  return row;
}

function resolveSourceFile(db, projectId, fileId) {
  const row = one(db, 'SELECT * FROM source_files WHERE project_id = ? AND id = ?', [projectId, fileId]);
  if (!row) throw new ApiError(404, 'source_file_not_found', 'Source file not found in this project.');
  return row;
}

function segmentIdsForTranslation(db, projectId, requested, translateAll = false) {
  if (requested && requested.length) {
    const rows = requested.map(value => rowForSegment(db, projectId, value)).filter(Boolean);
    if (rows.length !== requested.length) throw new ApiError(404, 'segment_not_found', 'One or more requested segments were not found in this project.');
     return rows.filter(row => !['scene_heading', 'character', 'transition'].includes(row.type)
      && !row.approved && row.manual_translation === null && (row.translation === null || row.translation === undefined || !String(row.translation).trim())).map(row => row.id);
  }
  const where = translateAll
    ? `AND manual_translation IS NULL AND approved = 0 AND (translation IS NULL OR TRIM(translation) = '')`
    : `AND COALESCE(manual_translation, translation) IS NULL AND approved = 0`;
  return many(db, `SELECT id FROM segments WHERE project_id = ? ${where} AND type IN ('dialogue', 'parenthetical', 'action') ORDER BY ordinal LIMIT ?`, [projectId, JOB_MAX_SEGMENTS]).map(row => row.id);
}

function validationSummary(issues) {
  return issues.reduce((summary, issue) => {
    summary.total += 1;
    summary[issue.severity] = (summary[issue.severity] || 0) + 1;
    return summary;
  }, { total: 0, error: 0, warning: 0 });
}

function firstForwardedValue(value) {
  return String(value || '').split(',')[0].trim();
}

function publicRequestOrigin(req, env) {
  const configured = String(env.CINEVERSE_PUBLIC_ORIGIN || '').trim();
  if (configured) return configured;
  // Render and other TLS-terminating proxies connect to Node over HTTP. Prefer
  // their client-facing origin headers so same-origin mutations still work.
  const protocol = firstForwardedValue(req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
  const host = firstForwardedValue(req.headers['x-forwarded-host']) || String(req.headers.host || '').trim();
  return host ? `${protocol}://${host}` : '';
}

function assertSameOrigin(req, env) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin) {
    const configuredOrigins = String(env.CINEVERSE_CORS_ORIGIN || '').split(',').map(item => item.trim()).filter(Boolean);
    const expected = publicRequestOrigin(req, env);
    let matches = false;
    try { matches = new URL(origin).origin === new URL(expected).origin; } catch { /* reject malformed origins */ }
    if (!matches && configuredOrigins.includes('*')) matches = true;
    if (!matches && configuredOrigins.some(item => { try { return new URL(origin).origin === new URL(item).origin; } catch { return false; } })) matches = true;
    if (!matches) throw new ApiError(403, 'cross_origin_request', 'Cross-origin mutations are not permitted.');
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new ApiError(403, 'cross_origin_request', 'Cross-site mutations are not permitted.');
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
}

function requireRole(project, roles) {
  if (!roles.includes(project.role)) throw new ApiError(403, 'forbidden', 'Your project role does not permit this action.');
}

function safeStoragePath(storageDir, relativePath) {
  const resolved = path.resolve(storageDir, relativePath);
  const relative = path.relative(path.resolve(storageDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ApiError(400, 'invalid_storage_path', 'Invalid stored file path.');
  return resolved;
}

function exportFileName(project, extension) {
  const title = String(project.title).normalize('NFKD').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'screenplay';
  return `${title}-${project.target_language}.${extension}`;
}

function translationVersionFromRow(row) {
  return {
    id: row.id, projectId: row.project_id, segmentId: row.segment_id, sourceText: row.source_text,
    translatedText: row.translated_text, provider: row.provider, model: row.model, createdBy: row.created_by,
    status: row.status, demo: row.provider === 'demo-fallback', createdAt: row.created_at,
  };
}

export function contextForSegment(db, projectId, segment) {
  const context = buildPipelineContext(db, projectId, segment);
  const project = one(db, 'SELECT translation_mode, context_depth, custom_instructions, adaptation FROM projects WHERE id = ?', [projectId]);
  context.project = project ? {
    translationMode: project.translation_mode,
    contextDepth: project.context_depth,
    customInstructions: project.custom_instructions,
    adaptation: project.adaptation,
  } : {};
  return context;
}

/** Returns a native Node HTTP server. Inject `db`, `aiAdapter`, or `env` in tests. */
export function createServer(options = {}) {
  const env = options.env || process.env;
  const db = options.db || createDatabase(options.dbPath || env.CINEVERSE_DB_PATH || DEFAULT_DB_PATH);
  const ownsDb = !options.db;
  const storageDir = path.resolve(options.storageDir || env.CINEVERSE_STORAGE_DIR || DEFAULT_STORAGE_DIR);
  const maxBytes = clamp(Number(options.maxUploadBytes ?? env.CINEVERSE_MAX_UPLOAD_BYTES) || DEFAULT_UPLOAD_LIMIT, 1, DEFAULT_UPLOAD_LIMIT);
  const sessionDays = clamp(Number(env.CINEVERSE_SESSION_DAYS) || SESSION_DAYS, 1, 90);
  const aiService = options.aiService || createAiService({ env, adapter: options.aiAdapter, allowDemoFallback: options.allowDemoFallback });
  const jobs = new Map();
  const authAttempts = new Map();
  const secureCookie = { secure: parseBoolean(env.CINEVERSE_COOKIE_SECURE, env.NODE_ENV === 'production') };
  let closing = false;
  let databaseClosed = false;

  // Jobs have durable receipts, but this dependency-free runner is single-process.
  // A restart marks interrupted work explicitly; it never silently repeats calls.
  run(db, `UPDATE processing_jobs SET status = 'failed', error_code = 'server_restarted', error_message = 'Processing stopped when the server restarted. Start a new job to continue.', completed_at = ?, updated_at = ? WHERE status IN ('queued', 'running')`, [timestamp(), timestamp()]);
  run(db, 'DELETE FROM sessions WHERE expires_at <= ?', [timestamp()]);

  function authRateLimit(req) {
    const now = Date.now();
    const key = req.socket.remoteAddress || 'unknown';
    for (const [address, entry] of authAttempts) if (entry.resetAt < now) authAttempts.delete(address);
    const entry = authAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (entry.count >= 30) throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Try again later.');
    entry.count += 1;
    authAttempts.set(key, entry);
  }

  function startTranslation(project, user, segmentIds, mode = 'translate') {
    if (!segmentIds.length) throw new ApiError(400, 'no_segments', 'There are no eligible segments to translate.');
    if (one(db, `SELECT id FROM processing_jobs WHERE project_id = ? AND status IN ('queued', 'running')`, [project.id])) {
      throw new ApiError(409, 'job_in_progress', 'This project already has a translation job in progress.');
    }
    const jobId = id();
    const at = timestamp();
    const result = { segmentIds, mode, demoFallback: Boolean(aiService.demo), provider: aiService.provider };
    run(db, `INSERT INTO processing_jobs(id, project_id, user_id, job_type, status, progress, total, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'translation', 'queued', 0, ?, ?, ?, ?)`, [jobId, project.id, user.id, segmentIds.length, JSON.stringify(result), at, at]);
    const controller = new AbortController();
    const promise = new Promise(resolve => setImmediate(resolve)).then(() => runTranslationJob({
      db, jobId, project, user, aiService, env, signal: controller.signal,
    })).catch(error => {
      if (!databaseClosed) run(db, `UPDATE processing_jobs SET status = 'failed', error_code = 'translation_failed', error_message = 'Translation could not be completed.', completed_at = ?, updated_at = ? WHERE id = ?`, [timestamp(), timestamp(), jobId]);
      console.error('Translation job failed:', error?.code || error?.name || 'error');
    }).finally(() => jobs.delete(jobId));
    jobs.set(jobId, { promise, controller });
    return jobFromRow(one(db, 'SELECT * FROM processing_jobs WHERE id = ?', [jobId]));
  }

  async function route(req, res) {
    securityHeaders(res);
    const requestOrigin = String(req.headers.origin || '');
    const corsOrigins = String(env.CINEVERSE_CORS_ORIGIN || '').split(',').map(item => item.trim()).filter(Boolean);
    if (requestOrigin && (corsOrigins.includes('*') || corsOrigins.some(item => item === requestOrigin))) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-File-Name');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    const url = new URL(req.url || '/', 'http://localhost');
    let parts;
    try { parts = parsePath(url.pathname); } catch { throw new ApiError(400, 'invalid_path', 'The request path is invalid.'); }
    const method = req.method || 'GET';
    if (parts[0] !== 'api') {
      if (!['GET', 'HEAD'].includes(method)) return methodNotAllowed(res, 'GET, HEAD');
      const staticFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/style.css', 'style.css'], ['/script.js', 'script.js'], ['/car.svg', 'car.svg'], ['/sample/sample-screenplay.fountain', 'sample/sample-screenplay.fountain']]);
      const file = staticFiles.get(url.pathname);
      if (!file) throw new ApiError(404, 'not_found', 'Resource not found.');
      let data;
      try { data = await fs.readFile(path.join(HERE, file)); } catch { throw new ApiError(404, 'not_found', 'Resource not found.'); }
      res.setHeader('Content-Type', MIME_TYPES[extensionOf(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', data.length);
      return res.end(method === 'HEAD' ? undefined : data);
    }
    assertSameOrigin(req, env);
    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Allow', 'GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS');
      return res.end();
    }
    if (closing) throw new ApiError(503, 'server_closing', 'The server is shutting down.');
    if (parts[1] === 'health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok', service: 'cineverse', ai: { provider: aiService.provider, model: aiService.model, configured: Boolean(options.aiAdapter || options.aiService || aiService.demo || (providerConfig(env).baseUrl && providerConfig(env).apiKey && providerConfig(env).model)), demoFallback: Boolean(aiService.demo) }, maxUploadBytes: maxBytes });
    }
    if (parts[1] === 'ai' && parts[2] === 'status' && method === 'GET') {
      return sendJson(res, 200, { ai: { ...aiServiceStatus({ env, service: aiService, allowDemoFallback: options.allowDemoFallback }), provider: aiService.provider, model: aiService.model } });
    }
    if (parts[1] === 'auth') {
      const action = parts[2];
      if (action === 'me' && method === 'GET') return sendJson(res, 200, { user: authenticatedUser(db, req) });
      if (action === 'logout' && method === 'POST') {
        const token = sessionTokenFromRequest(req);
        if (token) run(db, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
        setSessionCookie(res, '', 0, secureCookie);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'demo' && method === 'POST') {
        authRateLimit(req);
        if (!demoEnabled(env)) throw new ApiError(404, 'demo_disabled', 'The demo workspace is disabled on this server.');
        const current = authenticatedUser(db, req);
        if (current) {
          if (!current.demo) throw new ApiError(409, 'demo_requires_new_session', 'A signed-in account cannot be replaced by a demo session.');
          const existingProject = one(db, 'SELECT id FROM projects WHERE owner_id = ? AND demo = 1 ORDER BY created_at LIMIT 1', [current.id]);
          if (!existingProject) throw new ApiError(409, 'demo_already_exists', 'This demo account is already signed in.');
          return sendJson(res, 200, { user: current, projectId: existingProject.id });
        }
        const userId = id();
        const email = `demo+${randomBytes(18).toString('hex')}@local.cineverse.invalid`;
        const password = randomBytes(48).toString('base64url');
        const at = timestamp();
        run(db, 'INSERT INTO users(id, email, password_hash, display_name, demo, created_at) VALUES (?, ?, ?, ?, 1, ?)', [userId, email, hashPassword(password), 'CineVerse Demo', at]);
        const demoUser = userFromRow(one(db, 'SELECT * FROM users WHERE id = ?', [userId]));
        let projectId;
        try {
          projectId = await seedDemoProject({ db, user: demoUser, storageDir, maxBytes });
        } catch (error) {
          run(db, 'DELETE FROM users WHERE id = ?', [userId]);
          throw error;
        }
        const session = createSession(db, userId, sessionDays);
        setSessionCookie(res, session.token, sessionDays * 86400, secureCookie);
        return sendJson(res, 201, { user: demoUser, projectId });
      }
      if (['register', 'signup', 'login', 'signin'].includes(action) && method === 'POST') {
        authRateLimit(req);
        const { body } = await parseRequestBody(req, 16384);
        bodyObject(body);
        let user;
        if (action === 'register' || action === 'signup') {
          const fields = validateRegistration(body);
          const userId = id();
          try {
             run(db, 'INSERT INTO users(id, email, password_hash, display_name, demo, created_at) VALUES (?, ?, ?, ?, 0, ?)', [userId, fields.email, hashPassword(fields.password), fields.name, timestamp()]);
          } catch (error) {
            if (sqliteConflict(error)) throw new ApiError(409, 'email_registered', 'An account with this email already exists.');
            throw error;
          }
          user = userFromRow(one(db, 'SELECT * FROM users WHERE id = ?', [userId]));
        } else {
          const email = normalizeEmail(body.email);
          const password = String(body.password ?? '');
          if (password.length > 128 || email.length > 254) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
          const row = one(db, 'SELECT * FROM users WHERE email = ?', [email]);
          // Run the password derivation even when the email is unknown.
          const valid = verifyPassword(password, row?.password_hash || DUMMY_PASSWORD_HASH);
          if (!row || !valid) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
          user = userFromRow(row);
        }
        const previousToken = sessionTokenFromRequest(req);
        if (previousToken) run(db, 'DELETE FROM sessions WHERE token_hash = ?', [tokenHash(previousToken)]);
        const session = createSession(db, user.id, sessionDays);
        setSessionCookie(res, session.token, sessionDays * 86400, secureCookie);
        return sendJson(res, action === 'register' || action === 'signup' ? 201 : 200, { user, expiresAt: session.expiresAt });
      }
       if (['me', 'logout', 'demo', 'register', 'signup', 'login', 'signin'].includes(action)) return methodNotAllowed(res, action === 'me' ? 'GET' : 'POST');
      throw new ApiError(404, 'not_found', 'Authentication route not found.');
    }
    const user = requireUser(db, req);
    if (parts[1] === 'translate' && method === 'POST') {
      const { body } = await parseRequestBody(req, 128 * 1024);
      bodyObject(body);
      const text = textField(body.text ?? body.sourceText, 'text', { required: true, max: MAX_TRANSLATION_CHARS });
      const sourceLanguage = safeLanguage(body.sourceLanguage, 'sourceLanguage', 'auto');
      const targetLanguage = safeLanguage(body.targetLanguage, 'targetLanguage', 'en');
      if (body.glossary !== undefined && !Array.isArray(body.glossary)) throw new ApiError(400, 'invalid_glossary', 'glossary must be an array.');
      const glossary = Array.isArray(body.glossary) ? body.glossary.slice(0, 100).map(entry => ({
        sourceTerm: textField(entry?.sourceTerm ?? entry?.source_term, 'sourceTerm', { required: true, max: 250 }),
        targetTerm: textField(entry?.targetTerm ?? entry?.target_term, 'targetTerm', { required: true, max: 500 }),
        caseSensitive: Boolean(entry?.caseSensitive ?? entry?.case_sensitive),
      })) : [];
       const result = await aiService.translate({ text, sourceLanguage, targetLanguage, glossary, context: body.context || null, user, signal: AbortSignal.timeout(30000), env });
       return sendJson(res, 200, { translation: validateTranslationResponse(result), provider: result?.provider || aiService.provider, model: result?.model || aiService.model, demoFallback: Boolean(result?.demo || aiService.demo), demo: Boolean(result?.demo || aiService.demo), untranslated: Boolean(result?.untranslated), warnings: Array.isArray(result?.warnings) ? result.warnings : [] });
    }
    if (parts[1] === 'parse' && method === 'POST') {
      const input = await parseRequestBody(req);
      const upload = createUploadFromBody(bodyObject(input.body), { raw: !Object.keys(input.body).length ? input.raw : null, fileName: req.headers['x-file-name'], mimeType: req.headers['content-type'] });
      if (!upload) throw new ApiError(400, 'file_required', 'Upload a screenplay or supply sourceText.');
      const parsedUpload = parseUpload(upload, { maxBytes });
      const parsed = parseScreenplay(parsedUpload.text, { paragraphs: parsedUpload.paragraphs });
      if (parsed.segments.length > MAX_PROJECT_SEGMENTS) throw new ApiError(413, 'too_many_segments', `A project may contain at most ${MAX_PROJECT_SEGMENTS} screenplay segments.`);
      return sendJson(res, 200, { ...parsed, filename: parsedUpload.filename, parserStatus: parsedUpload.parserStatus });
    }
    if (parts[1] === 'jobs' && parts[2]) {
      const job = one(db, 'SELECT * FROM processing_jobs WHERE id = ?', [parts[2]]);
      if (!job) throw new ApiError(404, 'job_not_found', 'Job not found.');
      const project = requireProject(db, job.project_id, user.id, method !== 'GET');
      if (method === 'GET' && parts.length === 3) return sendJson(res, 200, { job: jobFromRow(job) });
      if (method === 'POST' && parts[3] === 'cancel') {
        requireRole(project, ['owner', 'editor']);
        if (['queued', 'running'].includes(job.status)) {
          run(db, `UPDATE processing_jobs SET cancel_requested = 1, status = 'cancelled', error_code = 'cancelled', error_message = 'Translation was cancelled.', completed_at = ?, updated_at = ? WHERE id = ?`, [timestamp(), timestamp(), job.id]);
          jobs.get(job.id)?.controller.abort();
        }
        return sendJson(res, 200, { job: jobFromRow(one(db, 'SELECT * FROM processing_jobs WHERE id = ?', [job.id])) });
      }
      throw new ApiError(404, 'not_found', 'Job route not found.');
    }
    if (parts[1] !== 'projects') throw new ApiError(404, 'not_found', 'API route not found.');
    if (parts.length === 2) {
      if (method === 'GET') return sendJson(res, 200, { projects: listProjectRows(db, user.id) });
      if (method !== 'POST') return methodNotAllowed(res, 'GET, POST');
      const { body } = await parseRequestBody(req);
      bodyObject(body);
      const title = textField(body.title, 'title', { required: true, max: 120 });
      const description = textField(body.description, 'description', { max: 4000 });
       const sourceLanguage = safeLanguage(body.sourceLanguage, 'sourceLanguage', 'en');
       const targetLanguage = safeLanguage(body.targetLanguage, 'targetLanguage', 'es');
       const settings = projectSettingsFromBody(body);
       if (targetLanguage === 'auto') throw new ApiError(400, 'invalid_targetLanguage', 'Choose a specific target language.');
      if (sourceLanguage === targetLanguage) throw new ApiError(400, 'invalid_language_pair', 'Source and target languages must be different.');
      const upload = createUploadFromBody(body);
      // Validate before creating a project, then keep creation all-or-nothing.
      if (upload) parseUpload(upload, { maxBytes });
      const projectId = id();
      const at = timestamp();
      executeTransaction(db, () => {
         run(db, `INSERT INTO projects(id, owner_id, title, description, source_language, target_language, translation_mode, context_depth, custom_instructions, adaptation, demo, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?)`, [projectId, user.id, title, description, sourceLanguage, targetLanguage, settings.translationMode, settings.contextDepth, settings.customInstructions, settings.adaptation, at, at]);
        run(db, 'INSERT INTO memberships(project_id, user_id, role, created_at) VALUES (?, ?, \'owner\', ?)', [projectId, user.id, at]);
      });
      try {
        if (upload) await persistUpload({ db, project: { id: projectId }, user, upload, storageDir, maxBytes });
      } catch (error) {
        run(db, 'DELETE FROM projects WHERE id = ?', [projectId]);
        throw error;
      }
      const bundle = projectBundle(db, projectId);
      bundle.project.role = 'owner';
      return sendJson(res, 201, bundle, { Location: `/api/projects/${projectId}` });
    }
    const projectId = parts[2];
    const resource = parts[3];
    const resourceId = parts[4];
    const project = requireProject(db, projectId, user.id);
    const mutate = () => requireRole(project, ['owner', 'editor']);
    const review = () => requireRole(project, ['owner', 'editor', 'reviewer']);
    if (parts.length === 3) {
      if (method === 'GET') {
        const bundle = projectBundle(db, projectId, url.searchParams.get('source') === 'true');
        bundle.project.role = project.role;
        return sendJson(res, 200, bundle);
      }
      if (method === 'PATCH' || method === 'PUT') {
        mutate();
        const { body } = await parseRequestBody(req, 16384);
        bodyObject(body);
        const title = textField(body.title ?? project.title, 'title', { required: true, max: 120 });
        const description = textField(body.description ?? project.description, 'description', { max: 4000 });
        const status = textField(body.status ?? project.status, 'status', { max: 40 });
        if (!['draft', 'in_progress', 'in_review', 'completed', 'archived'].includes(status)) throw new ApiError(400, 'invalid_status', 'Invalid project status.');
         const sourceLanguage = safeLanguage(body.sourceLanguage ?? project.source_language, 'sourceLanguage');
         const targetLanguage = safeLanguage(body.targetLanguage ?? project.target_language, 'targetLanguage');
         const settings = projectSettingsFromBody(body, project);
        if (targetLanguage === 'auto') throw new ApiError(400, 'invalid_targetLanguage', 'Choose a specific target language.');
        if (sourceLanguage === targetLanguage) throw new ApiError(400, 'invalid_language_pair', 'Source and target languages must be different.');
        if ((sourceLanguage !== project.source_language || targetLanguage !== project.target_language) && one(db, `SELECT id FROM segments WHERE project_id = ? AND (translation IS NOT NULL OR manual_translation IS NOT NULL) LIMIT 1`, [projectId])) {
          throw new ApiError(409, 'language_locked', 'Create a separate project for a new language pair once translations exist.');
        }
         run(db, `UPDATE projects SET title = ?, description = ?, status = ?, source_language = ?, target_language = ?,
           translation_mode = ?, context_depth = ?, custom_instructions = ?, adaptation = ?, updated_at = ? WHERE id = ?`, [title, description, status, sourceLanguage, targetLanguage, settings.translationMode, settings.contextDepth, settings.customInstructions, settings.adaptation, timestamp(), projectId]);
        return sendJson(res, 200, { project: projectFromRow(requireProject(db, projectId, user.id)) });
      }
      if (method === 'DELETE') {
        requireRole(project, ['owner']);
        if (one(db, `SELECT id FROM processing_jobs WHERE project_id = ? AND status IN ('queued', 'running')`, [projectId]) || [...jobs.keys()].some(jobId => one(db, 'SELECT id FROM processing_jobs WHERE id = ? AND project_id = ?', [jobId, projectId]))) {
          throw new ApiError(409, 'job_in_progress', 'Wait for the current translation job to finish before deleting the project.');
        }
        run(db, 'DELETE FROM projects WHERE id = ?', [projectId]);
        await fs.rm(path.join(storageDir, 'uploads', projectId), { recursive: true, force: true });
        await fs.rm(path.join(storageDir, 'exports', projectId), { recursive: true, force: true });
        return sendJson(res, 200, { ok: true });
      }
      return methodNotAllowed(res, 'GET, PATCH, PUT, DELETE');
    }
    if (['files', 'source-files', 'upload'].includes(resource)) {
      if (method === 'GET') {
        if (!resourceId) return sendJson(res, 200, { sourceFiles: many(db, 'SELECT * FROM source_files WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(sourceFileFromRow) });
        const file = resolveSourceFile(db, projectId, resourceId);
        return sendJson(res, 200, { sourceFile: { ...sourceFileFromRow(file), extractedText: file.extracted_text } });
      }
      if (method === 'POST' && !resourceId) {
        mutate();
        if (one(db, `SELECT id FROM processing_jobs WHERE project_id = ? AND status IN ('queued', 'running')`, [projectId])) throw new ApiError(409, 'job_in_progress', 'Wait for the translation job before uploading another source.');
        const input = await parseRequestBody(req);
        bodyObject(input.body);
        const upload = createUploadFromBody(input.body, { raw: !Object.keys(input.body).length ? input.raw : null, fileName: req.headers['x-file-name'], mimeType: req.headers['content-type'] });
        if (!upload) throw new ApiError(400, 'file_required', 'Upload a screenplay or supply sourceText.');
        const result = await persistUpload({ db, project, user, upload, storageDir, maxBytes });
        return sendJson(res, 201, { ...result, project: projectBundle(db, projectId).project });
      }
      if (method === 'DELETE' && resourceId) {
        mutate();
        if (one(db, `SELECT id FROM processing_jobs WHERE project_id = ? AND status IN ('queued', 'running')`, [projectId]) || [...jobs.keys()].some(jobId => one(db, 'SELECT id FROM processing_jobs WHERE id = ? AND project_id = ?', [jobId, projectId]))) {
          throw new ApiError(409, 'job_in_progress', 'Wait for the current translation job to finish before deleting a source file.');
        }
        const file = resolveSourceFile(db, projectId, resourceId);
        const absolutePath = safeStoragePath(storageDir, file.storage_path);
        run(db, 'DELETE FROM source_files WHERE id = ? AND project_id = ?', [file.id, projectId]);
        try { await fs.unlink(absolutePath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        updateProjectTimestamp(db, projectId);
        return sendJson(res, 200, { ok: true, fileId: file.id });
      }
      return methodNotAllowed(res, 'GET, POST, DELETE');
    }
    if (resource === 'scenes' && method === 'GET') {
      if (!resourceId) return sendJson(res, 200, { scenes: many(db, 'SELECT * FROM scenes WHERE project_id = ? ORDER BY scene_number', [projectId]).map(sceneFromRow) });
      const scene = resolveScene(db, projectId, resourceId);
      return sendJson(res, 200, { scene: sceneFromRow(scene), segments: many(db, 'SELECT * FROM segments WHERE project_id = ? AND scene_id = ? ORDER BY ordinal', [projectId, scene.id]).map(segmentFromRow) });
    }
    if (resource === 'segments') {
      if (method === 'GET' && !resourceId) {
        const sceneId = url.searchParams.get('sceneId');
        const segments = sceneId ? many(db, 'SELECT * FROM segments WHERE project_id = ? AND scene_id = ? ORDER BY ordinal', [projectId, resolveScene(db, projectId, sceneId).id]) : many(db, 'SELECT * FROM segments WHERE project_id = ? ORDER BY ordinal', [projectId]);
        return sendJson(res, 200, { segments: segments.map(segmentFromRow) });
      }
      if (!resourceId) throw new ApiError(404, 'segment_not_found', 'Segment not found.');
      const segment = resolveSegment(db, projectId, resourceId);
      if (method === 'GET' && parts[5] === 'versions') return sendJson(res, 200, { versions: many(db, 'SELECT * FROM translation_versions WHERE project_id = ? AND segment_id = ? ORDER BY created_at DESC, rowid DESC', [projectId, segment.id]).map(translationVersionFromRow) });
      if (method === 'GET' && (!parts[5] || parts[5] === 'translation')) return sendJson(res, 200, { segment: segmentFromRow(segment), context: contextForSegment(db, projectId, segment) });
      if ((method === 'PATCH' || method === 'PUT') && (!parts[5] || ['translation', 'edit'].includes(parts[5]))) {
        mutate();
        const { body } = await parseRequestBody(req, 128 * 1024);
        bodyObject(body);
        if (body.expectedUpdatedAt && body.expectedUpdatedAt !== segment.updated_at) throw new ApiError(409, 'edit_conflict', 'This segment changed. Reload it before saving.');
        const clearManual = body.clearManual === true || body.manualTranslation === null;
        const supplied = jsonBodyValue(body, 'translation', 'translatedText', 'manualTranslation');
        if (!clearManual && typeof supplied !== 'string') throw new ApiError(400, 'invalid_translation', 'Supply translation as a string.');
        const text = clearManual ? null : textField(supplied, 'translation', { max: MAX_TRANSLATION_CHARS });
        const retained = clearManual
          ? (typeof body.translation === 'string' ? textField(body.translation, 'translation', { max: MAX_TRANSLATION_CHARS }) : segment.translation)
          : text;
        const manualValue = text ? text : null;
        const at = timestamp();
        executeTransaction(db, () => {
          run(db, `UPDATE segments SET translation = ?, manual_translation = ?, approved = 0, translation_status = ?, updated_at = ? WHERE id = ? AND project_id = ?`, [retained, manualValue, retained ? 'edited' : 'pending', at, segment.id, projectId]);
          if (retained) run(db, `INSERT INTO translation_versions(id, project_id, segment_id, source_text, translated_text, provider, created_by, status, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, 'accepted', ?)`, [id(), projectId, segment.id, segment.text, retained, user.id, at]);
          updateProjectTimestamp(db, projectId);
        });
        validateProject(db, projectId, { segmentIds: [segment.id] });
        return sendJson(res, 200, { segment: segmentFromRow(resolveSegment(db, projectId, segment.id)) });
      }
      if (method === 'POST' && parts[5] === 'suggest') {
        review();
        const input = await parseRequestBody(req, 32768);
        const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
        const alternative = parseBoolean(body.alternative, false);
        const currentProject = one(db, 'SELECT * FROM projects WHERE id = ?', [projectId]);
        const glossary = many(db, `SELECT * FROM glossary_entries WHERE project_id = ? AND (scene_id IS NULL OR scene_id = ?) ORDER BY source_term`, [projectId, segment.scene_id || '']);
        const segmentGlossary = glossary.sort((a, b) => Number(Boolean(b.scene_id)) - Number(Boolean(a.scene_id)));
        const context = contextForSegment(db, projectId, segment);
        const signal = AbortSignal.timeout(30000);
        const result = await aiService.translate({
          text: segment.text,
          sourceLanguage: currentProject.source_language,
          targetLanguage: currentProject.target_language,
          glossary: segmentGlossary,
          context,
          project: projectFromRow(currentProject),
          segment,
          alternative,
          suggestion: true,
          signal,
          env,
        });
        const suggestion = suggestionFromResult(result, segment.text, segment.manual_translation ?? segment.translation ?? '', alternative);
        if (!suggestion.untranslated) {
          suggestion.warnings.push(...semanticCautions(segment.text, suggestion.translation, glossary).map(item => item.message));
        }
        return sendJson(res, 200, { ...suggestion, context });
      }
      if (method === 'POST' && ['translate', 'regenerate', 'alternative', 'generate'].includes(parts[5])) {
        mutate();
        if (segment.manual_translation !== null || segment.approved) throw new ApiError(409, 'translation_protected', 'Manual or approved translations are protected. Generate suggestions through a separate draft before replacing them.');
        const input = await parseRequestBody(req, 16384);
        const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
        const job = startTranslation(project, user, [segment.id], parts[5]);
        if (parseBoolean(url.searchParams.get('sync'), false) || parseBoolean(body.sync, false)) {
          await jobs.get(job.id)?.promise;
          const completed = jobFromRow(one(db, 'SELECT * FROM processing_jobs WHERE id = ?', [job.id]));
          return sendJson(res, completed?.status === 'completed' ? 200 : 502, { job: completed, jobId: job.id });
        }
        return sendJson(res, 202, { job, jobId: job.id }, { Location: `/api/jobs/${job.id}` });
      }
      if (method === 'POST' && ['review', 'approve', 'reject', 'ignore'].includes(parts[5])) {
        review();
        const { body } = await parseRequestBody(req, 16384);
        bodyObject(body);
        const decision = parts[5] === 'review' ? body.decision : parts[5];
         return sendJson(res, 200, saveReview(db, projectId, segment, user, decision, body.note, body.issueId));
      }
      throw new ApiError(404, 'not_found', 'Segment route not found.');
    }
    if (['translate', 'translation', 'translation-jobs'].includes(resource) && method === 'POST') {
      mutate();
      const { body } = await parseRequestBody(req, 65536);
      bodyObject(body);
      const requested = idList(body.segmentIds ?? (resourceId ? [resourceId] : undefined));
      const segmentIds = segmentIdsForTranslation(db, projectId, requested, parseBoolean(body.all, false));
      const job = startTranslation(project, user, segmentIds);
      if (parseBoolean(body.sync, false) || parseBoolean(url.searchParams.get('sync'), false)) {
        await jobs.get(job.id)?.promise;
        const completed = jobFromRow(one(db, 'SELECT * FROM processing_jobs WHERE id = ?', [job.id]));
        return sendJson(res, completed?.status === 'completed' ? 200 : 502, { job: completed, jobId: job.id });
      }
      return sendJson(res, 202, { job, jobId: job.id }, { Location: `/api/jobs/${job.id}` });
    }
    if (resource === 'jobs' && method === 'POST' && resourceId && parts[5] === 'cancel') {
      mutate();
      const job = one(db, 'SELECT * FROM processing_jobs WHERE project_id = ? AND id = ?', [projectId, resourceId]);
      if (!job) throw new ApiError(404, 'job_not_found', 'Job not found.');
      if (['queued', 'running'].includes(job.status)) {
        run(db, `UPDATE processing_jobs SET cancel_requested = 1, status = 'cancelled', error_code = 'cancelled', error_message = 'Translation was cancelled.', completed_at = ?, updated_at = ? WHERE id = ?`, [timestamp(), timestamp(), job.id]);
        jobs.get(job.id)?.controller.abort();
      }
      return sendJson(res, 200, { job: jobFromRow(one(db, 'SELECT * FROM processing_jobs WHERE id = ?', [job.id])) });
    }
    if (resource === 'jobs' && method === 'GET') {
      if (resourceId) {
        const job = one(db, 'SELECT * FROM processing_jobs WHERE project_id = ? AND id = ?', [projectId, resourceId]);
        if (!job) throw new ApiError(404, 'job_not_found', 'Job not found.');
        return sendJson(res, 200, { job: jobFromRow(job) });
      }
      return sendJson(res, 200, { jobs: many(db, 'SELECT * FROM processing_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100', [projectId]).map(jobFromRow) });
    }
    if (['validate', 'validation', 'validation-issues', 'qa'].includes(resource)) {
      if (method === 'GET') return sendJson(res, 200, { issues: many(db, 'SELECT * FROM validation_issues WHERE project_id = ? ORDER BY resolved, severity, created_at', [projectId]).map(validationIssueFromRow) });
      if (method === 'POST' && !resourceId) {
        review();
        const { body } = await parseRequestBody(req, 65536);
        bodyObject(body);
        const segmentIds = idList(body.segmentIds);
        if (segmentIds) segmentIds.forEach(segmentId => resolveSegment(db, projectId, segmentId));
        const issues = validateProject(db, projectId, { segmentIds });
        return sendJson(res, 200, { issues, summary: validationSummary(issues) });
      }
      if (method === 'PATCH' && resourceId) {
        review();
        const issue = one(db, 'SELECT * FROM validation_issues WHERE project_id = ? AND id = ?', [projectId, resourceId]);
        if (!issue) throw new ApiError(404, 'issue_not_found', 'Validation issue not found.');
        const { body } = await parseRequestBody(req, 16384);
        bodyObject(body);
        if (typeof body.resolved !== 'boolean') throw new ApiError(400, 'invalid_resolved', 'resolved must be true or false.');
        run(db, 'UPDATE validation_issues SET resolved = ? WHERE project_id = ? AND id = ?', [Number(body.resolved), projectId, resourceId]);
        return sendJson(res, 200, { issue: validationIssueFromRow(one(db, 'SELECT * FROM validation_issues WHERE id = ?', [resourceId])) });
      }
    }
    if (resource === 'review' || resource === 'reviews' || resource === 'review-decisions') {
      if (method === 'GET') return sendJson(res, 200, { decisions: many(db, 'SELECT * FROM review_decisions WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(decisionFromRow), issues: many(db, 'SELECT * FROM validation_issues WHERE project_id = ? AND resolved = 0 ORDER BY severity, created_at', [projectId]).map(validationIssueFromRow) });
      if (method === 'POST') {
         review();
         const { body } = await parseRequestBody(req, 16384);
         bodyObject(body);
         const issueForReview = body.issueId ? one(db, 'SELECT segment_id FROM validation_issues WHERE project_id = ? AND id = ?', [projectId, String(body.issueId)]) : null;
         const segmentRef = body.segmentId || issueForReview?.segment_id;
         const segment = resolveSegment(db, projectId, textField(segmentRef, 'segmentId', { required: true, max: 200 }));
         return sendJson(res, 201, saveReview(db, projectId, segment, user, body.decision, body.note, body.issueId));
      }
    }
    if (resource === 'memories') {
      if (method === 'GET') return sendJson(res, 200, { memories: many(db, 'SELECT * FROM context_memories WHERE project_id = ? ORDER BY created_at DESC', [projectId]).map(memoryFromRow) });
      mutate();
      if (method === 'DELETE' && resourceId) {
        if (!run(db, 'DELETE FROM context_memories WHERE id = ? AND project_id = ?', [resourceId, projectId]).changes) throw new ApiError(404, 'memory_not_found', 'Translation memory not found.');
        updateProjectTimestamp(db, projectId);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'POST' && !resourceId) {
        const { body } = await parseRequestBody(req, 32768);
        bodyObject(body);
        const sourceText = textField(body.sourceText ?? body.source, 'sourceText', { required: true, max: MAX_TRANSLATION_CHARS });
        const targetText = textField(body.targetText ?? body.target, 'targetText', { required: true, max: MAX_TRANSLATION_CHARS });
        const note = textField(body.note ?? body.notes, 'note', { max: 4000 });
        const sceneId = body.sceneId ? resolveScene(db, projectId, String(body.sceneId)).id : null;
        const duplicate = one(db, `SELECT * FROM context_memories WHERE project_id = ? AND source_text = ? AND target_text = ? AND (scene_id IS ? OR scene_id = ?)`, [projectId, sourceText, targetText, sceneId, sceneId]);
        if (duplicate) return sendJson(res, 200, { memory: memoryFromRow(duplicate), duplicate: true });
        const memoryId = id();
        run(db, 'INSERT INTO context_memories(id, project_id, source_text, target_text, note, scene_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [memoryId, projectId, sourceText, targetText, note, sceneId, user.id, timestamp()]);
        updateProjectTimestamp(db, projectId);
        return sendJson(res, 201, { memory: memoryFromRow(one(db, 'SELECT * FROM context_memories WHERE id = ?', [memoryId])) });
      }
      return methodNotAllowed(res, 'GET, POST, DELETE');
    }
    if (resource === 'glossary') {
      if (method === 'GET') return sendJson(res, 200, { glossary: many(db, 'SELECT * FROM glossary_entries WHERE project_id = ? ORDER BY source_term', [projectId]).map(glossaryFromRow) });
      mutate();
      if (method === 'POST' && resourceId === 'import') {
        const { body } = await parseRequestBody(req, 512 * 1024);
        bodyObject(body);
        if (!Array.isArray(body.entries) || body.entries.length > 2000) throw new ApiError(400, 'invalid_entries', 'entries must contain at most 2000 glossary entries.');
        const policy = String(body.policy || 'keep').toLowerCase();
        if (!['keep', 'update'].includes(policy)) throw new ApiError(400, 'invalid_policy', 'policy must be keep or update.');
        const entries = body.entries.map((entry, index) => {
          if (!entry || typeof entry !== 'object') throw new ApiError(400, 'invalid_entry', `Glossary entry ${index + 1} is invalid.`);
          const source = textField(entry.sourceTerm ?? entry.source, 'sourceTerm', { required: true, max: 250 });
          const target = textField(entry.targetTerm ?? entry.target, 'targetTerm', { required: true, max: 500 });
          const notes = textField(entry.notes, 'notes', { max: 2000 });
          const category = glossaryCategory(entry.category);
          const caseSensitive = parseBoolean(entry.caseSensitive ?? entry.case_sensitive, false);
          const sceneId = entry.sceneId ? resolveScene(db, projectId, String(entry.sceneId)).id : null;
          return { source, target, notes, category, caseSensitive, sceneId };
        });
        const counts = { added: 0, updated: 0, skipped: 0 };
        executeTransaction(db, () => {
          for (const entry of entries) {
            const existingEntry = one(db, `SELECT * FROM glossary_entries WHERE project_id = ? AND source_term = ? AND (scene_id IS ? OR scene_id = ?)`, [projectId, entry.source, entry.sceneId, entry.sceneId]);
            if (existingEntry && policy === 'keep') { counts.skipped += 1; continue; }
            const at = timestamp();
            if (existingEntry) {
              run(db, `UPDATE glossary_entries SET target_term = ?, notes = ?, case_sensitive = ?, category = ?, updated_at = ? WHERE id = ? AND project_id = ?`, [entry.target, entry.notes, Number(entry.caseSensitive), entry.category, at, existingEntry.id, projectId]);
              counts.updated += 1;
            } else {
              run(db, `INSERT INTO glossary_entries(id, project_id, source_term, target_term, notes, case_sensitive, category, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id(), projectId, entry.source, entry.target, entry.notes, Number(entry.caseSensitive), entry.category, entry.sceneId, at, at]);
              counts.added += 1;
            }
          }
          updateProjectTimestamp(db, projectId);
        });
        return sendJson(res, 200, counts);
      }
      const existing = resourceId ? one(db, 'SELECT * FROM glossary_entries WHERE id = ? AND project_id = ?', [resourceId, projectId]) : null;
      if (resourceId && !existing) throw new ApiError(404, 'glossary_not_found', 'Glossary entry not found.');
      if (method === 'DELETE' && resourceId) {
        run(db, 'DELETE FROM glossary_entries WHERE id = ? AND project_id = ?', [resourceId, projectId]);
        updateProjectTimestamp(db, projectId);
        return sendJson(res, 200, { ok: true });
      }
      if ((method === 'POST' && !resourceId) || ((method === 'PATCH' || method === 'PUT') && resourceId)) {
        const { body } = await parseRequestBody(req, 16384);
        bodyObject(body);
        const source = textField(body.sourceTerm ?? body.source ?? existing?.source_term, 'sourceTerm', { required: true, max: 250 });
        const target = textField(body.targetTerm ?? body.target ?? existing?.target_term, 'targetTerm', { required: true, max: 500 });
        const notes = textField(body.notes ?? existing?.notes, 'notes', { max: 2000 });
        const caseSensitive = parseBoolean(body.caseSensitive, Boolean(existing?.case_sensitive));
        const category = glossaryCategory(body.category ?? existing?.category);
        const sceneId = body.sceneId === null ? null : (body.sceneId ? resolveScene(db, projectId, String(body.sceneId)).id : (existing?.scene_id || null));
        const entryId = existing?.id || id();
        const at = timestamp();
        try {
          if (existing) run(db, 'UPDATE glossary_entries SET source_term = ?, target_term = ?, notes = ?, case_sensitive = ?, category = ?, scene_id = ?, updated_at = ? WHERE id = ? AND project_id = ?', [source, target, notes, Number(caseSensitive), category, sceneId, at, entryId, projectId]);
          else run(db, 'INSERT INTO glossary_entries(id, project_id, source_term, target_term, notes, case_sensitive, category, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [entryId, projectId, source, target, notes, Number(caseSensitive), category, sceneId, at, at]);
        } catch (error) {
          if (sqliteConflict(error)) throw new ApiError(409, 'duplicate_glossary_term', 'This source term already exists in the project glossary.');
          throw error;
        }
        updateProjectTimestamp(db, projectId);
        return sendJson(res, existing ? 200 : 201, { entry: glossaryFromRow(one(db, 'SELECT * FROM glossary_entries WHERE id = ?', [entryId])) });
      }
      return methodNotAllowed(res, 'GET, POST, PATCH, PUT, DELETE');
    }
    if (resource === 'context' || resource === 'characters' || resource === 'relationships' || resource === 'cultural-expressions') {
      if (method === 'GET') {
        const bundle = projectBundle(db, projectId);
        return sendJson(res, 200, { characters: bundle.characters, relationships: bundle.relationships, annotations: bundle.annotations, culturalExpressions: bundle.culturalExpressions, scenes: bundle.scenes });
      }
      mutate();
      if (resource === 'characters' && method === 'POST' && !resourceId) {
        const { body } = await parseRequestBody(req, 32768);
        bodyObject(body);
        const name = textField(body.name, 'name', { required: true, max: 120 });
        const metadata = body.metadata === undefined ? {} : bodyObject(body.metadata);
        const characterId = id();
        try {
          run(db, 'INSERT INTO characters(id, project_id, name, normalized_name, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [characterId, projectId, name, name.toLocaleLowerCase(), JSON.stringify(metadata), timestamp()]);
        } catch (error) {
          if (sqliteConflict(error)) throw new ApiError(409, 'duplicate_character', 'This character already exists in the project.');
          throw error;
        }
        updateProjectTimestamp(db, projectId);
        return sendJson(res, 201, { character: characterFromRow(one(db, 'SELECT * FROM characters WHERE id = ?', [characterId])) });
      }
      if (resource === 'characters' && resourceId && method === 'PATCH') {
        const character = one(db, 'SELECT * FROM characters WHERE id = ? AND project_id = ?', [resourceId, projectId]);
        if (!character) throw new ApiError(404, 'character_not_found', 'Character not found.');
        const { body } = await parseRequestBody(req, 32768);
        bodyObject(body);
         const metadata = body.metadata === undefined ? body : bodyObject(body.metadata);
         const allowed = ['role', 'description', 'voice', 'personality', 'formsOfAddress', 'recurringExpressions', 'emotionalDevelopment', 'age', 'gender', 'pronouns', 'notes', 'tags', 'relation'];
         const next = { ...parseMetadata(character.metadata_json) };
         const name = body.name === undefined ? character.name : textField(body.name, 'name', { required: true, max: 120 });
         for (const key of allowed) if (metadata[key] !== undefined) {
           if (key === 'tags') {
             if (!Array.isArray(metadata.tags) || metadata.tags.length > 20) throw new ApiError(400, 'invalid_tags', 'Supply up to 20 character tags.');
             next.tags = metadata.tags.map(tag => textField(tag, 'tag', { max: 80 }));
           } else if (['formsOfAddress', 'recurringExpressions'].includes(key) && Array.isArray(metadata[key])) {
             if (metadata[key].length > 20) throw new ApiError(400, `invalid_${key}`, `${key} may contain at most 20 items.`);
             next[key] = metadata[key].map(value => textField(value, key, { max: 240 }));
           } else next[key] = textField(metadata[key], key, { max: 2000 });
         }
         try {
           run(db, 'UPDATE characters SET name = ?, normalized_name = ?, metadata_json = ? WHERE id = ? AND project_id = ?', [name, name.toLocaleLowerCase(), JSON.stringify(next), resourceId, projectId]);
         } catch (error) {
           if (sqliteConflict(error)) throw new ApiError(409, 'duplicate_character', 'This character already exists in the project.');
           throw error;
         }
        updateProjectTimestamp(db, projectId);
        return sendJson(res, 200, { character: characterFromRow(one(db, 'SELECT * FROM characters WHERE id = ?', [resourceId])) });
      }
      if (resource === 'relationships' && method === 'POST') {
        const { body } = await parseRequestBody(req, 16384);
        bodyObject(body);
        const a = textField(body.characterAId, 'characterAId', { required: true, max: 200 });
        const b = textField(body.characterBId, 'characterBId', { required: true, max: 200 });
        if (a === b || !one(db, 'SELECT id FROM characters WHERE project_id = ? AND id = ?', [projectId, a]) || !one(db, 'SELECT id FROM characters WHERE project_id = ? AND id = ?', [projectId, b])) throw new ApiError(400, 'invalid_characters', 'Choose two different characters in this project.');
        const type = textField(body.relationshipType, 'relationshipType', { required: true, max: 80 });
        const notes = textField(body.notes, 'notes', { max: 2000 });
        const relationshipId = id();
        try { run(db, 'INSERT INTO character_relationships(id, project_id, character_a_id, character_b_id, relationship_type, confidence, notes, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)', [relationshipId, projectId, a, b, type, notes, timestamp()]); }
        catch (error) { if (sqliteConflict(error)) throw new ApiError(409, 'duplicate_relationship', 'This relationship already exists.'); throw error; }
        return sendJson(res, 201, { relationship: relationshipFromRow(one(db, 'SELECT * FROM character_relationships WHERE id = ?', [relationshipId])) });
      }
      if ((resource === 'context' || resource === 'cultural-expressions') && method === 'POST') {
        const { body } = await parseRequestBody(req, 32768);
        bodyObject(body);
        const segmentId = body.segmentId ? resolveSegment(db, projectId, String(body.segmentId)).id : null;
        const entryId = id();
        if (resource === 'cultural-expressions') {
          const expression = textField(body.expression, 'expression', { required: true, max: 500 });
          const explanation = textField(body.explanation, 'explanation', { max: 4000 });
          const suggestion = body.suggestedTranslation == null ? null : textField(body.suggestedTranslation, 'suggestedTranslation', { max: 4000 });
          run(db, 'INSERT INTO cultural_expressions(id, project_id, segment_id, expression, explanation, suggested_translation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [entryId, projectId, segmentId, expression, explanation, suggestion, timestamp()]);
          return sendJson(res, 201, { expression: expressionFromRow(one(db, 'SELECT * FROM cultural_expressions WHERE id = ?', [entryId])) });
        }
        const type = textField(body.annotationType ?? body.type ?? 'note', 'annotationType', { required: true, max: 80 });
        const value = textField(body.value ?? body.note, 'value', { required: true, max: 8000 });
        run(db, 'INSERT INTO context_annotations(id, project_id, segment_id, annotation_type, value, source, created_at) VALUES (?, ?, ?, ?, ?, \'manual\', ?)', [entryId, projectId, segmentId, type, value, timestamp()]);
        updateProjectTimestamp(db, projectId);
        return sendJson(res, 201, { annotation: annotationFromRow(one(db, 'SELECT * FROM context_annotations WHERE id = ?', [entryId])) });
      }
      if (resourceId && method === 'DELETE' && ['context', 'cultural-expressions', 'relationships'].includes(resource)) {
        const table = { context: 'context_annotations', 'cultural-expressions': 'cultural_expressions', relationships: 'character_relationships' }[resource];
        if (!run(db, `DELETE FROM ${table} WHERE id = ? AND project_id = ?`, [resourceId, projectId]).changes) throw new ApiError(404, 'not_found', 'Context entry not found.');
        return sendJson(res, 200, { ok: true });
      }
      throw new ApiError(404, 'not_found', 'Context route not found.');
    }
    if (resource === 'comments') {
      if (method === 'GET') return sendJson(res, 200, { comments: many(db, 'SELECT c.*, u.display_name AS author_name FROM comments c JOIN users u ON u.id = c.user_id WHERE c.project_id = ? ORDER BY c.created_at', [projectId]).map(commentFromRow) });
      review();
      const { body } = await parseRequestBody(req, 16384);
      bodyObject(body);
      if (method === 'POST' && !resourceId) {
        const segmentId = body.segmentId ? resolveSegment(db, projectId, String(body.segmentId)).id : null;
        const text = textField(body.body ?? body.text, 'body', { required: true, max: 4000 });
        const commentId = id();
        const at = timestamp();
        run(db, 'INSERT INTO comments(id, project_id, segment_id, user_id, body, resolved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', [commentId, projectId, segmentId, user.id, text, at, at]);
        return sendJson(res, 201, { comment: commentFromRow(one(db, 'SELECT * FROM comments WHERE id = ?', [commentId])) });
      }
      if ((method === 'PATCH' || method === 'PUT') && resourceId) {
        const comment = one(db, 'SELECT * FROM comments WHERE project_id = ? AND id = ?', [projectId, resourceId]);
        if (!comment) throw new ApiError(404, 'comment_not_found', 'Comment not found.');
        if (body.body !== undefined && comment.user_id !== user.id) throw new ApiError(403, 'forbidden', 'Only the author can edit a comment.');
        const text = textField(body.body ?? comment.body, 'body', { required: true, max: 4000 });
        run(db, 'UPDATE comments SET body = ?, resolved = ?, updated_at = ? WHERE id = ? AND project_id = ?', [text, Number(parseBoolean(body.resolved, Boolean(comment.resolved))), timestamp(), resourceId, projectId]);
        return sendJson(res, 200, { comment: commentFromRow(one(db, 'SELECT * FROM comments WHERE id = ?', [resourceId])) });
      }
      return methodNotAllowed(res, 'GET, POST, PATCH');
    }
    if (resource === 'members' || resource === 'memberships') {
      requireRole(project, ['owner']);
      if (method === 'GET') return sendJson(res, 200, { members: many(db, 'SELECT m.user_id AS userId, m.role, u.email, u.display_name AS name, m.created_at AS createdAt FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?', [projectId]) });
      if (method === 'DELETE' && resourceId) {
        if (resourceId === project.owner_id) throw new ApiError(400, 'owner_required', 'The project owner cannot be removed.');
        run(db, 'DELETE FROM memberships WHERE project_id = ? AND user_id = ?', [projectId, resourceId]);
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'POST' || method === 'PATCH') {
        const { body } = await parseRequestBody(req, 16384);
        bodyObject(body);
        const member = resourceId || body.userId ? one(db, 'SELECT id, email, display_name FROM users WHERE id = ?', [String(resourceId || body.userId)]) : one(db, 'SELECT id, email, display_name FROM users WHERE email = ?', [normalizeEmail(body.email)]);
        if (!member) throw new ApiError(404, 'user_not_found', 'The invited user must first register an account.');
        const role = String(body.role || 'editor');
        if (!PROJECT_ROLES.has(role) || role === 'owner') throw new ApiError(400, 'invalid_role', 'Choose editor, reviewer, or viewer.');
        if (member.id === project.owner_id) throw new ApiError(400, 'owner_required', 'The project owner role cannot be changed.');
        run(db, 'INSERT INTO memberships(project_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role', [projectId, member.id, role, timestamp()]);
        return sendJson(res, 200, { member: { userId: member.id, email: member.email, name: member.display_name, role } });
      }
      return methodNotAllowed(res, 'GET, POST, PATCH, DELETE');
    }
    if (resource === 'evaluate' || resource === 'evaluations' || resource === 'analytics') {
      if (method === 'GET') return sendJson(res, 200, { project: projectBundle(db, projectId).project, evaluations: many(db, 'SELECT * FROM evaluation_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', [projectId]).map(evaluationFromRow) });
      if (method === 'POST') {
        review();
        const issues = validateProject(db, projectId);
        const stats = projectStats(db, projectId);
        const eligible = one(db, `SELECT COUNT(*) AS total, SUM(CASE WHEN LENGTH(TRIM(COALESCE(manual_translation, translation, ''))) > 0 THEN 1 ELSE 0 END) AS translated, SUM(approved) AS approved FROM segments WHERE project_id = ? AND type IN ('dialogue', 'action', 'parenthetical')`, [projectId]);
        const metrics = { source: 'deterministic', semanticQualityAssessed: false, totalSegments: Number(stats.segment_count), translatableSegments: Number(eligible.total), translatedSegments: Number(eligible.translated || 0), approvedSegments: Number(eligible.approved || 0), coverage: eligible.total ? Math.round(Number(eligible.translated || 0) / Number(eligible.total) * 100) : 0, issues: validationSummary(issues) };
        const evaluationId = id();
        const at = timestamp();
        run(db, 'INSERT INTO evaluation_runs(id, project_id, user_id, status, metrics_json, created_at, completed_at) VALUES (?, ?, ?, \'completed\', ?, ?, ?)', [evaluationId, projectId, user.id, JSON.stringify(metrics), at, at]);
        return sendJson(res, 201, { evaluation: evaluationFromRow(one(db, 'SELECT * FROM evaluation_runs WHERE id = ?', [evaluationId])) });
      }
    }
    if (resource === 'export' || resource === 'exports') {
      if (resource === 'exports' && method === 'GET' && !resourceId && !url.searchParams.has('format')) return sendJson(res, 200, { exports: many(db, 'SELECT id, format, warning_count AS warningCount, metadata_json, created_at AS createdAt FROM exports WHERE project_id = ? ORDER BY created_at DESC LIMIT 100', [projectId]).map(row => ({ id: row.id, format: row.format, warningCount: Number(row.warningCount), createdAt: row.createdAt, metadata: parseMetadata(row.metadata_json) })) });
      if (method === 'GET' && resource === 'exports' && resourceId && !EXPORT_FORMATS.has(resourceId)) {
        const record = one(db, 'SELECT * FROM exports WHERE id = ? AND project_id = ?', [resourceId, projectId]);
        if (!record || !record.storage_path) throw new ApiError(404, 'export_not_found', 'Export not found.');
        const descriptor = EXPORT_FORMATS.get(record.format);
        const content = await fs.readFile(safeStoragePath(storageDir, record.storage_path));
        res.setHeader('Content-Type', descriptor.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(project, descriptor.extension)}"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.end(content);
      }
      if (method === 'GET' || method === 'POST') {
        let body = {};
        if (method === 'POST') { review(); body = bodyObject((await parseRequestBody(req, 16384)).body); }
        const format = String(body.format || url.searchParams.get('format') || resourceId || 'json').toLowerCase();
         if (!EXPORT_FORMATS.has(format)) throw new ApiError(400, 'unsupported_export_format', 'Supported formats: json, txt, fountain, fdx, docx, md, csv, review.');
        validateProject(db, projectId);
        const output = exportProject(db, projectId, format);
        const warnings = warningMetadata(db, projectId);
        if (method === 'POST') {
          const exportId = id();
          const directory = path.join(storageDir, 'exports', projectId);
          await fs.mkdir(directory, { recursive: true });
          const absolutePath = path.join(directory, `${exportId}.${output.extension}`);
          await fs.writeFile(absolutePath, output.content, { flag: 'wx', mode: 0o600 });
          try { run(db, 'INSERT INTO exports(id, project_id, user_id, format, storage_path, warning_count, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [exportId, projectId, user.id, format, path.relative(storageDir, absolutePath).split(path.sep).join('/'), warnings.count, JSON.stringify({ warnings, filename: exportFileName(project, output.extension) }), timestamp()]); }
          catch (error) { await fs.unlink(absolutePath).catch(() => {}); throw error; }
          return sendJson(res, 201, { export: { id: exportId, format, warningCount: warnings.count, downloadUrl: `/api/projects/${projectId}/exports/${exportId}`, filename: exportFileName(project, output.extension) } });
        }
        res.setHeader('Content-Type', output.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(project, output.extension)}"`);
        res.setHeader('X-CineVerse-Warnings', String(warnings.count));
        res.setHeader('Cache-Control', 'no-store');
        return res.end(output.content);
      }
    }
    throw new ApiError(404, 'not_found', 'Project route not found.');
  }

  const server = http.createServer((req, res) => route(req, res).catch(error => {
    if (!res.headersSent) sendError(res, error);
    else res.destroy();
  }));
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.db = db;
  server.storageDir = storageDir;
  server.aiService = aiService;
  server.waitForJobs = async () => { await Promise.allSettled([...jobs.values()].map(job => job.promise)); };
  server.shutdown = async () => {
    closing = true;
    for (const job of jobs.values()) job.controller.abort();
    await server.waitForJobs();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (ownsDb && !databaseClosed) { db.close(); databaseClosed = true; }
  };
  server.once('close', () => {
    closing = true;
    for (const job of jobs.values()) job.controller.abort();
    void server.waitForJobs().then(() => { if (ownsDb && !databaseClosed) { db.close(); databaseClosed = true; } });
  });
  return server;
}

function saveReview(db, projectId, segment, user, rawDecision, rawNote, rawIssueId = null) {
  const decision = String(rawDecision || '').toLowerCase();
  if (!REVIEW_DECISIONS.has(decision)) throw new ApiError(400, 'invalid_decision', 'Choose approve, needs_changes, reject, or ignore.');
  const approved = decision === 'approve' || decision === 'approved';
  const translation = segment.manual_translation ?? segment.translation;
  if (approved && !String(translation ?? '').trim()) throw new ApiError(409, 'missing_translation', 'Add a translation before approving this segment.');
  if (decision === 'ignore' && !String(rawNote ?? '').trim()) throw new ApiError(400, 'audit_note_required', 'An audit note is required when ignoring a review warning.');
  const normalized = approved ? 'approve' : 'needs_changes';
  const note = textField(rawNote, 'note', { max: 4000 });
  const decisionId = id();
  const issue = rawIssueId
    ? one(db, 'SELECT * FROM validation_issues WHERE project_id = ? AND id = ? AND segment_id = ?', [projectId, String(rawIssueId), segment.id])
    : one(db, `SELECT * FROM validation_issues WHERE project_id = ? AND segment_id = ? AND resolved = 0 ORDER BY created_at DESC LIMIT 1`, [projectId, segment.id]);
  if (rawIssueId && !issue) throw new ApiError(404, 'issue_not_found', 'The review issue does not belong to this segment.');
  executeTransaction(db, () => {
    run(db, 'INSERT INTO review_decisions(id, project_id, segment_id, user_id, decision, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [decisionId, projectId, segment.id, user.id, decision === 'ignore' ? 'ignore' : normalized, note, timestamp()]);
    run(db, 'UPDATE segments SET approved = ?, translation_status = ?, updated_at = ? WHERE id = ? AND project_id = ?', [Number(approved), decision === 'ignore' ? segment.translation_status : (approved ? 'translated' : 'rejected'), timestamp(), segment.id, projectId]);
    if (decision === 'ignore' && issue) run(db, `UPDATE validation_issues SET resolved = 1, source = 'review_ignore' WHERE project_id = ? AND id = ?`, [projectId, issue.id]);
    if (approved && String(translation ?? '').trim()) {
      const duplicate = one(db, `SELECT id FROM context_memories WHERE project_id = ? AND source_text = ? AND target_text = ? AND (scene_id IS ? OR scene_id = ?)`, [projectId, segment.text, translation, segment.scene_id, segment.scene_id]);
      if (!duplicate) run(db, 'INSERT INTO context_memories(id, project_id, source_text, target_text, note, scene_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id(), projectId, segment.text, translation, 'Approved translation memory', segment.scene_id, user.id, timestamp()]);
    }
    updateProjectTimestamp(db, projectId);
  });
  if (decision !== 'ignore') validateProject(db, projectId, { segmentIds: [segment.id] });
  return { decision: decisionFromRow(one(db, 'SELECT * FROM review_decisions WHERE id = ?', [decisionId])), segment: segmentFromRow(resolveSegment(db, projectId, segment.id)) };
}

const DUMMY_PASSWORD_HASH = 'scrypt$16384$8$1$Y2luZXZlcnNlLWR1bW15IQ$RObAaUZv8cLaJCPwDiCKEuPNNkhucGnldF6h_x-q-gVoAGMlL3tJMGn2Tqv2l5pVVhWqNqgEeyQi7Trbnneglg';

export const createApp = createServer;

export async function startServer(options = {}) {
  const server = createServer(options);
  const runtimeEnv = options.env || process.env;
  const port = Number(options.port ?? runtimeEnv.PORT ?? 3000);
  const host = options.host || runtimeEnv.HOST || (String(runtimeEnv.NODE_ENV || '').toLowerCase() === 'production' ? '0.0.0.0' : '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await startServer();
  const address = server.address();
  console.log(`CineVerse listening on http://${address.address}:${address.port}`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.shutdown().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
