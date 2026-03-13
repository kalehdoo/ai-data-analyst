CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
  username      TEXT NOT NULL,
  role          TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  details       TEXT,
  model         TEXT,
  context_mode  TEXT,
  duration_ms   INTEGER,
  row_count     INTEGER,
  status        TEXT DEFAULT 'success',
  error_msg     TEXT
);

CREATE TABLE IF NOT EXISTS saved_queries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT,
  sql           TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_pinned     INTEGER DEFAULT 0,
  is_shared     INTEGER DEFAULT 0,
  tags          TEXT,
  run_count     INTEGER DEFAULT 0,
  last_run_at   DATETIME
);

CREATE TABLE IF NOT EXISTS query_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  sql         TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO query_templates (name, description, category, sql) VALUES
('Row Count All Tables',    'Count rows in every table',           'Monitoring', 'SELECT name, (SELECT COUNT(*) FROM sqlite_master WHERE type=''table'') as total_tables FROM sqlite_master WHERE type=''table'''),
('Recent Records',          'Last 100 rows from any table',        'Exploration', 'SELECT * FROM {table_name} ORDER BY rowid DESC LIMIT 100'),
('Duplicate Check',         'Find duplicate values in a column',   'Quality',    'SELECT {column_name}, COUNT(*) as count FROM {table_name} GROUP BY {column_name} HAVING COUNT(*) > 1 ORDER BY count DESC'),
('Null Check',              'Count nulls per column',              'Quality',    'SELECT COUNT(*) - COUNT({column_name}) as null_count, COUNT(*) as total FROM {table_name}'),
('Date Range Filter',       'Filter records by date range',        'Filtering',  'SELECT * FROM {table_name} WHERE {date_column} BETWEEN ''2024-01-01'' AND ''2024-12-31'''),
('Top N by Value',          'Top 10 records by a numeric column',  'Analysis',   'SELECT * FROM {table_name} ORDER BY {numeric_column} DESC LIMIT 10'),
('Group By Summary',        'Aggregate by a category column',      'Analysis',   'SELECT {category_column}, COUNT(*) as count, SUM({numeric_column}) as total FROM {table_name} GROUP BY {category_column} ORDER BY count DESC'),
('Table Schema',            'Show column info for a table',        'Exploration','PRAGMA table_info({table_name})');