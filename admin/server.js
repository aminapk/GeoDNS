const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { createDatabase, getDraft, replaceDraft, getSettings, setSettings } = require("./db");
const { applyDraftToCoreDNS, rollbackLatestBackup, loadDraftFromCoreDNS } = require("./coredns");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const idx = trimmed.indexOf("=");
    if (idx === -1) {
      return;
    }

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile("/etc/geodns-admin.env");

const app = express();
const db = createDatabase();
const PORT = Number(process.env.GEODNS_ADMIN_PORT || 3000);
const SESSION_SECRET =
  process.env.GEODNS_ADMIN_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const DEFAULT_SETUP_NS1 = process.env.GEODNS_SETUP_DEFAULT_NS1 || "ns1.example.com.";
const DEFAULT_SETUP_NS2 = process.env.GEODNS_SETUP_DEFAULT_NS2 || "ns2.example.com.";

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    name: "geodns.sid",
    proxy: true,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.GEODNS_ADMIN_COOKIE_SECURE === "true",
      maxAge: 1000 * 60 * 60 * 12
    }
  })
);

function getAdminUser() {
  return db.prepare("SELECT * FROM admin_user WHERE id = 1").get();
}

function hasAdminUser() {
  return Boolean(getAdminUser());
}

function ensureAdminUserFromEnvIfProvided() {
  if (hasAdminUser()) {
    return;
  }
  const hashFromEnv = process.env.GEODNS_ADMIN_PASSWORD_HASH;
  if (!hashFromEnv) {
    return;
  }
  const username = process.env.GEODNS_ADMIN_USERNAME || "admin";
  db.prepare("INSERT INTO admin_user (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)")
    .run(username, hashFromEnv, new Date().toISOString());
}

ensureAdminUserFromEnvIfProvided();

function syncDraftFromCoreDNSIfEmpty() {
  const existing = getDraft(db);
  const discovered = loadDraftFromCoreDNS();
  if (!discovered.domains.length) {
    return;
  }

  if (!existing.length) {
    replaceDraft(db, discovered.domains);
    return;
  }

  const existingDomains = new Set(existing.map((item) => item.name));
  const hasMissingDomain = discovered.domains.some((item) => !existingDomains.has(item.name));
  if (hasMissingDomain) {
    replaceDraft(db, discovered.domains);
  }
}

syncDraftFromCoreDNSIfEmpty();

function normalizeNameserver(value) {
  const item = String(value || "").trim();
  if (!item) {
    return null;
  }
  return item.endsWith(".") ? item : `${item}.`;
}

function validateDomainName(name) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    String(name || "").trim().toLowerCase()
  );
}

function validateDraft(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error("Add at least one domain before applying.");
  }

  domains.forEach((domain) => {
    const domainName = String(domain.name || "").trim().toLowerCase();
    if (!validateDomainName(domainName)) {
      throw new Error(`Invalid domain name: ${domainName || "(empty)"}`);
    }

    const views = Array.isArray(domain.views) ? domain.views : [];
    if (!views.length) {
      throw new Error(`Domain '${domainName}' must contain at least one view.`);
    }

    const defaultViews = views.filter((view) => view.is_default);
    if (!defaultViews.length) {
      throw new Error(`Domain '${domainName}' must have one default view.`);
    }
    if (defaultViews.length > 1) {
      throw new Error(`Domain '${domainName}' has multiple default views.`);
    }

    const hasRootAnswer = views.some((view) =>
      (view.records || []).some(
        (record) => String(record.name || "").trim() === "@" && String(record.value || "").trim()
      )
    );
    if (!hasRootAnswer) {
      throw new Error(`Domain '${domainName}' needs at least one '@' record value.`);
    }

    views.forEach((view) => {
      if (!view.is_default && !String(view.match_expression || "").trim()) {
        throw new Error(`View '${view.name}' in '${domainName}' requires a match expression.`);
      }
      (view.records || []).forEach((record) => {
        if (!String(record.type || "").trim() || !String(record.value || "").trim()) {
          throw new Error(`Domain '${domainName}' has incomplete records in view '${view.name}'.`);
        }
      });
    });
  });
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.adminUserId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  return next();
}

app.get("/api/setup/status", (_req, res) => {
  res.json({
    setup_required: !hasAdminUser(),
    defaults: {
      username: "admin",
      nameservers: [DEFAULT_SETUP_NS1, DEFAULT_SETUP_NS2]
    }
  });
});

app.post("/api/setup", (req, res) => {
  if (hasAdminUser()) {
    return res.status(400).json({ error: "Setup already completed." });
  }

  const username = String(req.body?.username || "admin").trim() || "admin";
  const password = String(req.body?.password || "");
  const nameserversRaw = Array.isArray(req.body?.nameservers)
    ? req.body.nameservers
    : [DEFAULT_SETUP_NS1, DEFAULT_SETUP_NS2];
  const nameservers = nameserversRaw.map(normalizeNameserver).filter(Boolean);

  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (!nameservers.length) {
    return res.status(400).json({ error: "At least one default nameserver is required." });
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  db.prepare("INSERT INTO admin_user (id, username, password_hash, created_at) VALUES (1, ?, ?, ?)")
    .run(username, passwordHash, new Date().toISOString());
  setSettings(db, { nameservers });

  req.session.adminUserId = 1;
  return res.json({ ok: true, username });
});

app.post("/api/login", (req, res) => {
  if (!hasAdminUser()) {
    return res.status(403).json({ error: "Setup is required before login." });
  }
  const { username, password } = req.body || {};
  const user = getAdminUser();
  const expectedUsername = user ? user.username : "admin";
  if (!user || username !== expectedUsername) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const ok = bcrypt.compareSync(String(password || ""), user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  req.session.adminUserId = user.id;
  return res.json({ ok: true, username: user.username });
});

app.post("/api/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/session", (req, res) => {
  if (!hasAdminUser()) {
    return res.json({ authenticated: false, setup_required: true });
  }
  if (!req.session || !req.session.adminUserId) {
    return res.json({ authenticated: false });
  }
  const user = db.prepare("SELECT username FROM admin_user WHERE id = 1").get();
  return res.json({ authenticated: true, username: user ? user.username : "admin" });
});

app.get("/api/draft", requireAuth, (req, res) => {
  const discovered = loadDraftFromCoreDNS();
  const draft = getDraft(db);
  const corefileDomainSet = new Set(discovered.domains.map((item) => item.name));
  const extraDraftWarnings = draft
    .map((item) => item.name)
    .filter((name) => !corefileDomainSet.has(name))
    .map(
      (name) =>
        `Draft domain '${name}' is not present in Corefile. It will be written only after you Apply Changes.`
    );
  res.json({
    domains: draft,
    warnings: [...discovered.warnings, ...extraDraftWarnings]
  });
});

app.post("/api/draft", requireAuth, (req, res) => {
  const domains = Array.isArray(req.body?.domains) ? req.body.domains : null;
  if (!domains) {
    return res.status(400).json({ error: "domains array is required" });
  }

  try {
    validateDraft(domains);
    replaceDraft(db, domains);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/api/apply", requireAuth, (req, res) => {
  try {
    const draft = getDraft(db);
    validateDraft(draft);
    const settings = getSettings(db);
    const result = applyDraftToCoreDNS(draft, settings);
    return res.json({ ok: true, domains: draft.length, backup: result.backupDir });
  } catch (err) {
    return res.status(500).json({ error: `Failed to apply changes: ${err.message}` });
  }
});

app.post("/api/rollback-last", requireAuth, (_req, res) => {
  try {
    const result = rollbackLatestBackup();
    return res.json({ ok: true, backup: result.backupDir });
  } catch (err) {
    return res.status(500).json({ error: `Failed to rollback: ${err.message}` });
  }
});

app.post("/api/sync-from-coredns", requireAuth, (_req, res) => {
  try {
    const discovered = loadDraftFromCoreDNS();
    replaceDraft(db, discovered.domains);
    return res.json({ ok: true, domains: discovered.domains.length, warnings: discovered.warnings });
  } catch (err) {
    return res.status(500).json({ error: `Failed to sync from CoreDNS: ${err.message}` });
  }
});

app.get("/api/settings", requireAuth, (_req, res) => {
  try {
    return res.json(getSettings(db));
  } catch (err) {
    return res.status(500).json({ error: `Failed to read settings: ${err.message}` });
  }
});

app.post("/api/settings", requireAuth, (req, res) => {
  try {
    const settings = setSettings(db, req.body || {});
    return res.json({ ok: true, settings });
  } catch (err) {
    return res.status(400).json({ error: `Failed to save settings: ${err.message}` });
  }
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store");
    }
  })
);
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`GeoDNS admin listening on ${PORT}\n`);
});
