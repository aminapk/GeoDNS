const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");

const COREDNS_ROOT = process.env.COREDNS_ROOT || "/etc/coredns";
const COREDNS_ZONES_DIR = path.join(COREDNS_ROOT, "zones");
const GEOIP_DB_PATH = process.env.GEODNS_GEOIP_DB_PATH || "/etc/coredns/geoip/GeoLite2-City.mmdb";
const COREDNS_SERVICE = process.env.COREDNS_SERVICE || "coredns";
const COREDNS_BIN = process.env.COREDNS_BIN || "/usr/local/bin/coredns";
const BACKUPS_ROOT = process.env.GEODNS_BACKUPS_ROOT || "/var/lib/geodns-admin/backups";

function normalizeDomainName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeNameserver(value) {
  const item = String(value || "").trim();
  if (!item) {
    return null;
  }
  return item.endsWith(".") ? item : `${item}.`;
}

function getNameservers(settings, domainName) {
  const fromSettings = Array.isArray(settings?.nameservers)
    ? settings.nameservers.map(normalizeNameserver).filter(Boolean)
    : [];
  if (fromSettings.length) {
    return fromSettings;
  }
  return [`ns1.${domainName}.`, `ns2.${domainName}.`];
}

function soaSerial() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return Number(`${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`);
}

function formatRecord(record) {
  const host = record.name || "@";
  const type = (record.type || "A").toUpperCase();
  const ttlPrefix = record.ttl ? `${record.ttl} ` : "";

  if (type === "MX") {
    const priority = Number(record.priority || 10);
    return `${host} ${ttlPrefix}IN MX ${priority} ${record.value}`;
  }
  if (type === "SRV") {
    const priority = Number(record.priority || 0);
    const weight = Number(record.weight || 0);
    const port = Number(record.port || 0);
    return `${host} ${ttlPrefix}IN SRV ${priority} ${weight} ${port} ${record.value}`;
  }
  if (type === "TXT") {
    const value = String(record.value || "").startsWith('"') ? record.value : `"${record.value}"`;
    return `${host} ${ttlPrefix}IN TXT ${value}`;
  }
  return `${host} ${ttlPrefix}IN ${type} ${record.value}`;
}

function renderZoneFile(domain, view, settings) {
  const ttl = Number(domain.default_ttl || 300);
  const serial = soaSerial();
  const viewRecords = Array.isArray(view.records) ? view.records : [];
  const nsFromView = viewRecords
    .filter((record) => String(record.type || "").toUpperCase() === "NS")
    .map((record) => normalizeNameserver(record.value))
    .filter(Boolean);
  const nameservers = nsFromView.length ? nsFromView : getNameservers(settings, domain.name);
  const primaryNs = nameservers[0];
  const adminHost = `admin.${domain.name}.`;

  const header = [
    `$TTL ${ttl}`,
    `@ IN SOA ${primaryNs} ${adminHost} (`,
    `  ${serial} ; serial`,
    "  3600 ; refresh",
    "  900 ; retry",
    "  604800 ; expire",
    `  ${ttl} ) ; minimum`
  ];
  nameservers.forEach((ns) => header.push(`@ IN NS ${ns}`));
  header.push("");

  const body = viewRecords.map((record) => formatRecord(record));
  return `${header.concat(body).join("\n")}\n`;
}

function renderCorefile(draftDomains) {
  const lines = [".:53 {", "  errors", "  health :8080", "  ready :8181", "  prometheus :9153", "  log", "}", ""];

  draftDomains.forEach((domain) => {
    const views = Array.isArray(domain.views) ? domain.views : [];
    const defaultView = views.find((view) => view.is_default) || views.find((view) => view.name === "default");

    views.filter((view) => !view.is_default).forEach((view) => {
      const zoneFile = path.join(COREDNS_ZONES_DIR, `${domain.name}.${view.name}.db`);
      const expression = (view.match_expression || "").trim();

      lines.push(`${domain.name}:53 {`);
      lines.push(`  view ${view.name} {`);
      lines.push(`    expr ${expression || "false"}`);
      lines.push("  }");
      lines.push(`  geoip ${GEOIP_DB_PATH} {`);
      lines.push("    edns-subnet");
      lines.push("  }");
      lines.push("  metadata");
      lines.push(`  file ${zoneFile}`);
      lines.push("}");
      lines.push("");
    });

    if (defaultView) {
      const zoneFile = path.join(COREDNS_ZONES_DIR, `${domain.name}.${defaultView.name}.db`);
      lines.push(`${domain.name}:53 {`);
      lines.push(`  geoip ${GEOIP_DB_PATH} {`);
      lines.push("    edns-subnet");
      lines.push("  }");
      lines.push("  metadata");
      lines.push(`  file ${zoneFile}`);
      lines.push("}");
      lines.push("");
    }
  });

  return `${lines.join("\n").trim()}\n`;
}

function parseZoneRecord(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith(";") || line.startsWith("$")) {
    return null;
  }
  let normalized = line.replace(/\s+/g, " ");
  if (/^IN\s+/i.test(normalized)) {
    normalized = `@ ${normalized}`;
  }
  const match = normalized.match(/^(\S+)\s+(?:(\d+)\s+)?IN\s+([A-Z]+)\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const [, name, ttl, typeRaw, rest] = match;
  const type = typeRaw.toUpperCase();

  if (type === "MX") {
    const mxMatch = rest.match(/^(\d+)\s+(.+)$/);
    if (!mxMatch) return null;
    return { name, ttl: ttl ? Number(ttl) : null, type, value: mxMatch[2].trim(), priority: Number(mxMatch[1]), weight: null, port: null };
  }
  if (type === "SRV") {
    const srvMatch = rest.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!srvMatch) return null;
    return {
      name,
      ttl: ttl ? Number(ttl) : null,
      type,
      value: srvMatch[4].trim(),
      priority: Number(srvMatch[1]),
      weight: Number(srvMatch[2]),
      port: Number(srvMatch[3])
    };
  }
  return { name, ttl: ttl ? Number(ttl) : null, type, value: rest.replace(/^"(.*)"$/, "$1").trim(), priority: null, weight: null, port: null };
}

function parseZoneFile(zonePath) {
  const source = fs.readFileSync(zonePath, "utf8");
  const lines = source.split(/\r?\n/);
  let inSoaBlock = false;
  let ttl = 300;
  const records = [];

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith("$TTL")) {
      const ttlValue = Number(line.split(/\s+/)[1]);
      if (ttlValue > 0) ttl = ttlValue;
      return;
    }
    if (/IN\s+SOA\s+/i.test(line) && line.includes("(")) {
      inSoaBlock = true;
      return;
    }
    if (inSoaBlock) {
      if (line.includes(")")) inSoaBlock = false;
      return;
    }
    const record = parseZoneRecord(line);
    if (record) records.push(record);
  });

  return { ttl, records };
}

function parseCorefileBlocks() {
  const corefilePath = path.join(COREDNS_ROOT, "Corefile");
  if (!fs.existsSync(corefilePath)) return [];

  const lines = fs.readFileSync(corefilePath, "utf8").split(/\r?\n/);
  const blocks = [];
  let block = null;

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    if (!block) {
      const startMatch = line.match(/^([a-z0-9.-]+):53\s*\{$/i);
      if (startMatch && startMatch[1] !== ".") {
        block = { domain: normalizeDomainName(startMatch[1]), depth: 1, viewName: null, expression: null, zoneViewName: null, zoneFile: null };
      }
      return;
    }

    const openCount = (line.match(/\{/g) || []).length;
    const closeCount = (line.match(/\}/g) || []).length;
    const viewMatch = line.match(/^view\s+([a-z0-9_-]+)\s*\{$/i);
    if (viewMatch) block.viewName = viewMatch[1].toLowerCase();
    if (line.startsWith("expr ")) block.expression = line.slice(5).trim();

    const fileMatch = line.match(/file\s+(.+)\s*$/);
    if (fileMatch) {
      const resolvedFile = fileMatch[1].trim();
      block.zoneFile = resolvedFile;
      const fileName = path.basename(resolvedFile);
      const parsed = fileName.match(/^(.+)\.([^.]+)\.db$/);
      if (parsed) block.zoneViewName = parsed[2].toLowerCase();
    }

    block.depth += openCount - closeCount;
    if (block.depth <= 0) {
      if (block.zoneFile) {
        blocks.push({
          domain: block.domain,
          viewName: (block.viewName || block.zoneViewName || "default").toLowerCase(),
          expression: block.expression ? block.expression.trim() : null,
          zoneFile: block.zoneFile
        });
      }
      block = null;
    }
  });
  return blocks;
}

function loadDraftFromCoreDNS() {
  const blocks = parseCorefileBlocks();
  const grouped = new Map();
  const corefileDomains = new Set();
  const referencedZoneFiles = new Set();

  blocks.forEach((block) => {
    corefileDomains.add(block.domain);
    referencedZoneFiles.add(path.resolve(block.zoneFile));
    const zonePath = path.resolve(block.zoneFile);
    const parsedZone = fs.existsSync(zonePath) ? parseZoneFile(zonePath) : { ttl: 300, records: [] };
    if (!grouped.has(block.domain)) grouped.set(block.domain, []);

    grouped.get(block.domain).push({
      name: block.viewName,
      is_default: !block.expression,
      match_expression: block.expression || null,
      records: parsedZone.records,
      _zoneTtl: parsedZone.ttl
    });
  });

  const domains = Array.from(grouped.entries())
    .map(([name, views]) => {
      const hasDefault = views.some((view) => view.is_default);
      if (!hasDefault && views.length > 0) {
        const fallbackDefault = views.find((item) => item.name === "default") || views[0];
        fallbackDefault.is_default = true;
      }
      const fallbackTtl = views.find((view) => Number(view._zoneTtl))?._zoneTtl || 300;
      return {
        name,
        default_ttl: fallbackTtl,
        views: views
          .map((view) => {
            const clean = { ...view };
            delete clean._zoneTtl;
            return clean;
          })
          .sort((a, b) => Number(a.is_default) - Number(b.is_default))
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const orphanDomains = new Set();
  if (fs.existsSync(COREDNS_ZONES_DIR)) {
    fs.readdirSync(COREDNS_ZONES_DIR)
      .filter((name) => name.endsWith(".db"))
      .forEach((name) => {
        const zonePath = path.resolve(path.join(COREDNS_ZONES_DIR, name));
        if (referencedZoneFiles.has(zonePath)) return;
        const parsed = name.match(/^(.+)\.([^.]+)\.db$/);
        if (!parsed) return;
        const domain = normalizeDomainName(parsed[1]);
        if (!corefileDomains.has(domain)) orphanDomains.add(domain);
      });
  }

  return {
    domains,
    warnings: Array.from(orphanDomains).map(
      (domain) => `Zone files exist for '${domain}', but this domain is not present in Corefile and was not imported.`
    )
  };
}

function writeDraftToPaths(draftDomains, settings, targetRoot) {
  const zoneDir = path.join(targetRoot, "zones");
  fs.mkdirSync(zoneDir, { recursive: true });

  fs.readdirSync(zoneDir, { withFileTypes: true }).forEach((entry) => {
    if (entry.isFile() && entry.name.endsWith(".db")) {
      fs.rmSync(path.join(zoneDir, entry.name), { force: true });
    }
  });

  draftDomains.forEach((domain) => {
    (domain.views || []).forEach((view) => {
      const zonePath = path.join(zoneDir, `${domain.name}.${view.name}.db`);
      fs.writeFileSync(zonePath, renderZoneFile(domain, view, settings), "utf8");
    });
  });

  const corefile = renderCorefile(draftDomains).replaceAll(`${COREDNS_ZONES_DIR}/`, `${zoneDir}/`);
  fs.writeFileSync(path.join(targetRoot, "Corefile"), corefile, "utf8");
}

function dryRunDraft(draftDomains, settings) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "geodns-dryrun-"));
  try {
    writeDraftToPaths(draftDomains, settings, tempRoot);
    const tempZones = path.join(tempRoot, "zones");
    const dryRunCorefilePath = path.join(tempRoot, "Corefile.dryrun");
    const liveCorefilePath = path.join(tempRoot, "Corefile");
    const dryRunCorefile = fs
      .readFileSync(liveCorefilePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        return !(
          trimmed.startsWith("health ") ||
          trimmed.startsWith("ready ") ||
          trimmed.startsWith("prometheus ")
        );
      })
      .map((line) => line.replace(/:53(\s*\{)/g, ":1053$1"))
      .join("\n");
    fs.writeFileSync(dryRunCorefilePath, `${dryRunCorefile.trim()}\n`, "utf8");
    const checkzoneProbe = spawnSync("named-checkzone", ["-h"], {
      encoding: "utf8",
      stdio: "pipe"
    });
    const hasNamedCheckzone = !checkzoneProbe.error || checkzoneProbe.error.code !== "ENOENT";

    if (hasNamedCheckzone) {
      fs.readdirSync(tempZones)
        .filter((name) => name.endsWith(".db"))
        .forEach((name) => {
          const parsed = name.match(/^(.+)\.([^.]+)\.db$/);
          const domain = parsed ? parsed[1] : "example.invalid";
          execFileSync("named-checkzone", [domain, path.join(tempZones, name)], { stdio: "pipe" });
        });
    }

    const result = spawnSync(COREDNS_BIN, ["-conf", dryRunCorefilePath, "-dns.port", "1053"], {
      timeout: 2500,
      encoding: "utf8"
    });

    if (result.error && result.error.code !== "ETIMEDOUT") {
      throw new Error(result.error.message);
    }
    if (result.status && result.status !== 0) {
      throw new Error(result.stderr || "CoreDNS dry-run failed");
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function createBackupSnapshot() {
  fs.mkdirSync(BACKUPS_ROOT, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const backupDir = path.join(BACKUPS_ROOT, stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(path.join(COREDNS_ROOT, "Corefile"))) {
    fs.copyFileSync(path.join(COREDNS_ROOT, "Corefile"), path.join(backupDir, "Corefile"));
  }
  if (fs.existsSync(COREDNS_ZONES_DIR)) {
    fs.mkdirSync(path.join(backupDir, "zones"), { recursive: true });
    fs.readdirSync(COREDNS_ZONES_DIR)
      .filter((name) => name.endsWith(".db"))
      .forEach((name) => {
        fs.copyFileSync(path.join(COREDNS_ZONES_DIR, name), path.join(backupDir, "zones", name));
      });
  }
  return backupDir;
}

function applyDraftToCoreDNS(draftDomains, settings) {
  fs.mkdirSync(COREDNS_ROOT, { recursive: true });
  fs.mkdirSync(COREDNS_ZONES_DIR, { recursive: true });

  dryRunDraft(draftDomains, settings);
  const backupDir = createBackupSnapshot();
  writeDraftToPaths(draftDomains, settings, COREDNS_ROOT);
  execFileSync("systemctl", ["restart", COREDNS_SERVICE], { stdio: "pipe" });
  return { backupDir };
}

function rollbackLatestBackup() {
  if (!fs.existsSync(BACKUPS_ROOT)) {
    throw new Error("No backups directory found.");
  }
  const entries = fs
    .readdirSync(BACKUPS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!entries.length) {
    throw new Error("No backup snapshot available.");
  }
  const latest = entries[entries.length - 1];
  const backupDir = path.join(BACKUPS_ROOT, latest);
  const backupCorefile = path.join(backupDir, "Corefile");
  const backupZonesDir = path.join(backupDir, "zones");

  if (!fs.existsSync(backupCorefile)) {
    throw new Error("Latest backup is incomplete: missing Corefile.");
  }
  fs.copyFileSync(backupCorefile, path.join(COREDNS_ROOT, "Corefile"));
  fs.mkdirSync(COREDNS_ZONES_DIR, { recursive: true });
  fs.readdirSync(COREDNS_ZONES_DIR)
    .filter((name) => name.endsWith(".db"))
    .forEach((name) => fs.rmSync(path.join(COREDNS_ZONES_DIR, name), { force: true }));
  if (fs.existsSync(backupZonesDir)) {
    fs.readdirSync(backupZonesDir)
      .filter((name) => name.endsWith(".db"))
      .forEach((name) => fs.copyFileSync(path.join(backupZonesDir, name), path.join(COREDNS_ZONES_DIR, name)));
  }
  execFileSync("systemctl", ["restart", COREDNS_SERVICE], { stdio: "pipe" });
  return { backupDir };
}

module.exports = {
  applyDraftToCoreDNS,
  rollbackLatestBackup,
  loadDraftFromCoreDNS
};
