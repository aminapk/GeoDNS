const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.GEODNS_ADMIN_DB_PATH || "/var/lib/geodns-admin/admin.db";

function ensureDbDirectory() {
  const dbDir = path.dirname(DB_PATH);
  fs.mkdirSync(dbDir, { recursive: true });
}

function createDatabase() {
  ensureDbDirectory();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_user (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      default_ttl INTEGER NOT NULL DEFAULT 300
    );

    CREATE TABLE IF NOT EXISTS views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      match_expression TEXT,
      FOREIGN KEY(domain_id) REFERENCES domains(id) ON DELETE CASCADE,
      UNIQUE(domain_id, name)
    );

    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      view_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '@',
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      ttl INTEGER,
      priority INTEGER,
      weight INTEGER,
      port INTEGER,
      FOREIGN KEY(view_id) REFERENCES views(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

const DEFAULT_SETTINGS = {
  nameservers: ["ns1.example.com.", "ns2.example.com."]
};

function parseSettingValue(value) {
  try {
    return JSON.parse(value);
  } catch (_err) {
    return value;
  }
}

function getSettings(db) {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const fromDb = rows.reduce((acc, row) => {
    acc[row.key] = parseSettingValue(row.value);
    return acc;
  }, {});

  const nameservers = Array.isArray(fromDb.nameservers)
    ? fromDb.nameservers
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((item) => (item.endsWith(".") ? item : `${item}.`))
    : DEFAULT_SETTINGS.nameservers;

  return {
    nameservers: nameservers.length ? nameservers : DEFAULT_SETTINGS.nameservers
  };
}

function setSettings(db, settings) {
  const payload = {
    nameservers: Array.isArray(settings?.nameservers)
      ? settings.nameservers
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .map((item) => (item.endsWith(".") ? item : `${item}.`))
      : DEFAULT_SETTINGS.nameservers
  };

  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  upsert.run("nameservers", JSON.stringify(payload.nameservers));
  return payload;
}

function getDraft(db) {
  const domains = db.prepare("SELECT * FROM domains ORDER BY name ASC").all();
  const views = db.prepare("SELECT * FROM views ORDER BY id ASC").all();
  const records = db.prepare("SELECT * FROM records ORDER BY id ASC").all();

  return domains.map((domain) => {
    const domainViews = views
      .filter((view) => view.domain_id === domain.id)
      .map((view) => ({
        ...view,
        is_default: Boolean(view.is_default),
        records: records.filter((record) => record.view_id === view.id)
      }));

    return {
      ...domain,
      views: domainViews
    };
  });
}

function replaceDraft(db, draftDomains) {
  const tx = db.transaction((domains) => {
    db.exec("DELETE FROM records; DELETE FROM views; DELETE FROM domains;");

    const insertDomain = db.prepare(
      "INSERT INTO domains (name, default_ttl) VALUES (@name, @default_ttl)"
    );
    const insertView = db.prepare(
      "INSERT INTO views (domain_id, name, is_default, match_expression) VALUES (@domain_id, @name, @is_default, @match_expression)"
    );
    const insertRecord = db.prepare(
      "INSERT INTO records (view_id, name, type, value, ttl, priority, weight, port) VALUES (@view_id, @name, @type, @value, @ttl, @priority, @weight, @port)"
    );

    domains.forEach((domain) => {
      const domainInfo = insertDomain.run({
        name: String(domain.name || "").trim().toLowerCase(),
        default_ttl: Number(domain.default_ttl) || 300
      });

      const domainId = domainInfo.lastInsertRowid;
      const normalizedViews = Array.isArray(domain.views) ? domain.views : [];
      const hasDefault = normalizedViews.some((v) => v.is_default);

      if (!hasDefault) {
        normalizedViews.push({
          name: "default",
          is_default: true,
          match_expression: null,
          records: []
        });
      }

      normalizedViews.forEach((view, index) => {
        const viewInfo = insertView.run({
          domain_id: domainId,
          name: String(view.name || `view${index + 1}`).trim().toLowerCase(),
          is_default: view.is_default ? 1 : 0,
          match_expression: view.is_default
            ? null
            : String(view.match_expression || "").trim() || null
        });

        const viewId = viewInfo.lastInsertRowid;
        const viewRecords = Array.isArray(view.records) ? view.records : [];
        viewRecords.forEach((record) => {
          insertRecord.run({
            view_id: viewId,
            name: String(record.name || "@").trim() || "@",
            type: String(record.type || "A").trim().toUpperCase(),
            value: String(record.value || "").trim(),
            ttl: record.ttl ? Number(record.ttl) : null,
            priority: record.priority ? Number(record.priority) : null,
            weight: record.weight ? Number(record.weight) : null,
            port: record.port ? Number(record.port) : null
          });
        });
      });
    });
  });

  tx(draftDomains);
}

module.exports = {
  createDatabase,
  getDraft,
  replaceDraft,
  getSettings,
  setSettings
};
