-- Task Manager: schema iniziale.
-- Gli slug restano in inglese (work, todo, high...): li legge l'MCP.
-- Le etichette italiane stanno nell'interfaccia.

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  area        TEXT NOT NULL CHECK (area IN ('work', 'personal')),
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  notes         TEXT,
  -- NULL finche' il task e' in inbox e nessuno l'ha smistato.
  area          TEXT CHECK (area IN ('work', 'personal')),
  project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'todo', 'done')),
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal', 'low')),
  due_date      TEXT,   -- YYYY-MM-DD, nel fuso dell'utente
  due_time      TEXT,   -- HH:MM, facoltativa
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('claude', 'telegram', 'web', 'api')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at  TEXT,
  -- Il cestino e' una data, non uno stato: cosi' ripristinare riporta il
  -- task esattamente com'era.
  deleted_at    TEXT
);

CREATE INDEX idx_tasks_status   ON tasks (status, deleted_at);
CREATE INDEX idx_tasks_due      ON tasks (due_date);
CREATE INDEX idx_tasks_project  ON tasks (project_id);
CREATE INDEX idx_tasks_deleted  ON tasks (deleted_at);

-- Registro: cosa e' successo, chi l'ha fatto. Serve per capire un errore
-- dell'AI, per il limite sui tentativi di accesso e per non mandare due
-- volte lo stesso riepilogo.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  details     TEXT,   -- JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_events_type ON events (type, created_at);
