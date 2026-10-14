PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_language TEXT NOT NULL DEFAULT 'en',
  target_language TEXT NOT NULL DEFAULT 'en',
  translation_mode TEXT NOT NULL DEFAULT 'natural',
  context_depth TEXT NOT NULL DEFAULT 'balanced',
  custom_instructions TEXT NOT NULL DEFAULT '',
  adaptation TEXT NOT NULL DEFAULT 'direct',
  demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memberships (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id, project_id);

CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  extracted_text TEXT NOT NULL,
  parser_status TEXT NOT NULL DEFAULT 'parsed',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_source_files_project ON source_files(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_files_hash ON source_files(project_id, sha256);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  stable_id TEXT NOT NULL,
  scene_number INTEGER NOT NULL,
  heading TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, stable_id)
);

CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id, scene_number);

CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL,
  source_file_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  stable_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,
  base_type TEXT NOT NULL,
  text TEXT NOT NULL,
  translation TEXT,
  manual_translation TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  translation_status TEXT NOT NULL DEFAULT 'pending',
  speaker TEXT,
  delivery TEXT,
  line_start INTEGER,
  line_end INTEGER,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, stable_id)
);

CREATE INDEX IF NOT EXISTS idx_segments_project ON segments(project_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_segments_scene ON segments(scene_id, ordinal);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS character_relationships (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_a_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  character_b_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'co_occurrence',
  confidence REAL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, character_a_id, character_b_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS context_annotations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
  annotation_type TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cultural_expressions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
  expression TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  suggested_translation TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary_entries (
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
);

CREATE INDEX IF NOT EXISTS idx_glossary_project ON glossary_entries(project_id, source_term);

CREATE TABLE IF NOT EXISTS context_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_text TEXT NOT NULL,
  target_text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS translation_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_translation_versions_segment ON translation_versions(segment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS validation_issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Terminology',
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'deterministic',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_validation_project ON validation_issues(project_id, resolved, severity);

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  segment_id TEXT REFERENCES segments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_project ON processing_jobs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  format TEXT NOT NULL,
  storage_path TEXT,
  warning_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_decisions_project ON review_decisions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id, resolved, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_annotations_project ON context_annotations(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cultural_expressions_project ON cultural_expressions(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exports_project ON exports(project_id, created_at DESC);
