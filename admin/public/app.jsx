const { useEffect, useMemo, useRef, useState } = React;

const EXPRESSION_VARIABLES = [
  { id: "country", label: "Country Code", path: "geoip/country/code", defaultValue: "US" },
  { id: "continent", label: "Continent Code", path: "geoip/continent/code", defaultValue: "EU" },
  { id: "asn", label: "ASN", path: "geoip/asn", defaultValue: "15169" },
  { id: "city", label: "City Name", path: "geoip/city/names/en", defaultValue: "Paris" }
];

const emptyRecord = () => ({
  name: "@",
  type: "A",
  value: "",
  ttl: "",
  priority: "",
  weight: "",
  port: ""
});

function makeExprRule(variable = EXPRESSION_VARIABLES[0]) {
  return {
    path: variable.path,
    operator: "==",
    value: variable.defaultValue,
    join: "&&",
    openParen: 0,
    closeParen: 0
  };
}

function buildExpressionFromView(view) {
  const rules = Array.isArray(view._expr_rules) ? view._expr_rules : [];
  const tokens = [];

  rules.forEach((rule, index) => {
    const value = String(rule.value || "").trim();
    if (!value) {
      return;
    }

    const path = rule.path || EXPRESSION_VARIABLES[0].path;
    const operator = rule.operator || "==";
    const join = rule.join || "&&";
    const openParen = Math.max(0, Number(rule.openParen || 0));
    const closeParen = Math.max(0, Number(rule.closeParen || 0));
    const condition = `${"(".repeat(openParen)}metadata('${path}') ${operator} '${value}'${")".repeat(
      closeParen
    )}`;

    if (index > 0) {
      tokens.push(join);
    }
    tokens.push(condition);
  });

  if (!tokens.length) {
    return "";
  }
  return tokens.join(" ");
}

function parseExpression(expression) {
  const expr = String(expression || "").trim();
  if (!expr) {
    return null;
  }

  const tokens = expr.split(/\s*(&&|\|\|)\s*/).filter(Boolean);
  if (!tokens.length) {
    return null;
  }

  const rules = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (i % 2 === 1) continue;
    const part = tokens[i].trim();
    const openMatch = part.match(/^(\(*)/);
    const closeMatch = part.match(/(\)*)$/);
    const openParen = openMatch ? openMatch[1].length : 0;
    const closeParen = closeMatch ? closeMatch[1].length : 0;
    const core = part.replace(/^\(+/, "").replace(/\)+$/, "").trim();
    const match = core.match(/^metadata\('([^']+)'\)\s*(==|!=)\s*'([^']*)'$/);
    if (!match) {
      return null;
    }
    const variable = EXPRESSION_VARIABLES.find((item) => item.path === match[1]);
    if (!variable) {
      return null;
    }
    rules.push({
      path: match[1],
      operator: match[2],
      value: match[3],
      join: i >= 2 ? tokens[i - 1] : "&&",
      openParen,
      closeParen
    });
  }

  return {
    mode: "builder",
    rules
  };
}

function withExpressionUi(view) {
  if (view.is_default) {
    return { ...view };
  }
  const parsed = parseExpression(view.match_expression);
  if (parsed) {
    return {
      ...view,
      _expr_mode: parsed.mode,
      _expr_rules: parsed.rules.length ? parsed.rules : [makeExprRule()]
    };
  }
  return {
    ...view,
    _expr_mode: "manual",
    _expr_rules: [makeExprRule()]
  };
}

function normalizeForUi(domains) {
  return (domains || []).map((domain) => ({
    ...domain,
    views: (domain.views || []).map((view) => withExpressionUi(view))
  }));
}

function sanitizeForApi(domains) {
  return (domains || []).map((domain) => ({
    name: String(domain.name || "").trim().toLowerCase(),
    default_ttl: Number(domain.default_ttl || 300),
    views: (domain.views || []).map((view) => {
      const payload = {
        name: String(view.name || "").trim().toLowerCase(),
        is_default: Boolean(view.is_default),
        records: (view.records || []).map((record) => ({
          name: String(record.name || "@").trim() || "@",
          type: String(record.type || "A").trim().toUpperCase(),
          value: String(record.value || "").trim(),
          ttl: record.ttl ? Number(record.ttl) : "",
          priority: record.priority ? Number(record.priority) : "",
          weight: record.weight ? Number(record.weight) : "",
          port: record.port ? Number(record.port) : ""
        }))
      };

      if (!view.is_default) {
        payload.match_expression =
          view._expr_mode === "builder"
            ? buildExpressionFromView(view)
            : String(view.match_expression || "").trim();
      }
      return payload;
    })
  }));
}

function emptyDomain(settings) {
  const first = EXPRESSION_VARIABLES[0];
  const nameservers = Array.isArray(settings?.nameservers)
    ? settings.nameservers.filter(Boolean)
    : [];
  const defaultNsRecords = nameservers.map((ns) => ({
    name: "@",
    type: "NS",
    value: ns,
    ttl: "",
    priority: "",
    weight: "",
    port: ""
  }));
  return {
    name: "",
    default_ttl: 300,
    views: [
      {
        name: "default",
        is_default: true,
        match_expression: "",
        records: [...defaultNsRecords, emptyRecord()]
      },
      {
        name: "geo-us",
        is_default: false,
        match_expression: `metadata('${first.path}') == '${first.defaultValue}'`,
        _expr_mode: "builder",
        _expr_rules: [makeExprRule(first)],
        records: [...defaultNsRecords, emptyRecord()]
      }
    ]
  };
}

function App() {
  const [session, setSession] = useState({ loading: true, authenticated: false });
  const [login, setLogin] = useState({ username: "admin", password: "" });
  const [setup, setSetup] = useState({
    username: "admin",
    password: "",
    confirmPassword: "",
    nameservers: ["ns1.example.com.", "ns2.example.com."]
  });
  const [domains, setDomains] = useState([]);
  const [selectedDomainIndex, setSelectedDomainIndex] = useState(-1);
  const [domainSearch, setDomainSearch] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [settings, setSettings] = useState({ nameservers: ["ns1.example.com.", "ns2.example.com."] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [changePassword, setChangePassword] = useState({ current: "", next: "", confirm: "", error: "", success: "" });
  const cloudflareFileRef = useRef(null);

  async function refreshSettings() {
    const r = await fetch("/api/settings");
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data.error || "Failed to load settings");
    }
    const ns = Array.isArray(data.nameservers) ? data.nameservers : [];
    setSettings({
      nameservers: [ns[0] || "ns1.example.com.", ns[1] || "ns2.example.com."]
    });
  }

  async function refreshDraft() {
    const r = await fetch("/api/draft");
    const data = await r.json();
    if (!r.ok) {
      throw new Error(data.error || "Failed to load draft");
    }
    setDomains(normalizeForUi(data.domains || []));
    setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
  }

  useEffect(() => {
    Promise.all([fetch("/api/session").then((r) => r.json()), fetch("/api/setup/status").then((r) => r.json())])
      .then(([sessionData, setupData]) => {
        setSession({ loading: false, ...sessionData, setup_required: Boolean(setupData.setup_required) });
        if (setupData?.defaults) {
          setSetup((prev) => ({
            ...prev,
            username: setupData.defaults.username || prev.username,
            nameservers: Array.isArray(setupData.defaults.nameservers)
              ? [
                  setupData.defaults.nameservers[0] || prev.nameservers[0],
                  setupData.defaults.nameservers[1] || prev.nameservers[1]
                ]
              : prev.nameservers
          }));
        }
      })
      .catch(() => setSession({ loading: false, authenticated: false, setup_required: false }));
  }, []);

  useEffect(() => {
    if (!session.authenticated) {
      return;
    }
    Promise.all([refreshDraft(), refreshSettings()]).catch((err) => setMessage(err.message));
  }, [session.authenticated]);

  const hasInvalidData = useMemo(() => {
    function isBalancedParens(input) {
      let balance = 0;
      for (const ch of input) {
        if (ch === "(") balance += 1;
        if (ch === ")") balance -= 1;
        if (balance < 0) return false;
      }
      return balance === 0;
    }

    return sanitizeForApi(domains).some((domain) => {
      if (!domain.name || !Array.isArray(domain.views) || !domain.views.length) {
        return true;
      }
      return domain.views.some((view) => {
        if (!view.is_default && !String(view.match_expression || "").trim()) {
          return true;
        }
        if (!view.is_default && !isBalancedParens(String(view.match_expression || "").trim())) {
          return true;
        }
        return (view.records || []).some((record) => !record.type || !record.value);
      });
    });
  }, [domains]);

  const filteredDomainOptions = useMemo(() => {
    const keyword = domainSearch.trim().toLowerCase();
    return domains
      .map((domain, index) => ({ domain, index }))
      .filter(({ domain }) => {
        if (!keyword) {
          return true;
        }
        return domain.name.toLowerCase().includes(keyword);
      });
  }, [domains, domainSearch]);

  useEffect(() => {
    if (!domains.length) {
      setSelectedDomainIndex(-1);
      return;
    }
    if (selectedDomainIndex < 0 || selectedDomainIndex >= domains.length) {
      setSelectedDomainIndex(0);
    }
  }, [domains, selectedDomainIndex]);

  async function handleLogin(e) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(login)
      });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data.error || "Login failed");
      }
      setSession({ loading: false, authenticated: true, username: data.username });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetup(e) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (setup.password !== setup.confirmPassword) {
        throw new Error("Passwords do not match.");
      }
      const payload = {
        username: setup.username || "admin",
        password: setup.password,
        nameservers: setup.nameservers
      };
      const r = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data.error || "Setup failed");
      }
      setSession({ loading: false, authenticated: true, username: data.username, setup_required: false });
      setMessage("");
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await fetch("/api/logout", { method: "POST" });
      setSession({ loading: false, authenticated: false });
      setDomains([]);
      setSelectedDomainIndex(-1);
      setWarnings([]);
      setMessage("");
    } finally {
      setBusy(false);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setChangePassword((prev) => ({ ...prev, error: "", success: "" }));
    if (changePassword.next !== changePassword.confirm) {
      setChangePassword((prev) => ({ ...prev, error: "New passwords do not match." }));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: changePassword.current, new_password: changePassword.next })
      });
      const data = await r.json();
      if (!r.ok) {
        setChangePassword((prev) => ({ ...prev, error: data.error || "Failed to change password." }));
      } else {
        setChangePassword({ current: "", next: "", confirm: "", error: "", success: "Password changed successfully." });
      }
    } catch (err) {
      setChangePassword((prev) => ({ ...prev, error: err.message }));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    setBusy(true);
    setMessage("");
    try {
      const payload = {
        nameservers: (settings.nameservers || []).map((item) => String(item || "").trim()).filter(Boolean)
      };
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data.error || "Failed to save nameservers");
      }
      await Promise.all([refreshSettings(), refreshDraft()]);
      setMessage("Default nameservers saved");
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyChanges() {
    setBusy(true);
    setMessage("");
    try {
      const payload = sanitizeForApi(domains);
      const saveReq = await fetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains: payload })
      });
      const saveData = await saveReq.json();
      if (!saveReq.ok) {
        throw new Error(saveData.error || "Save failed");
      }

      const applyReq = await fetch("/api/apply", { method: "POST" });
      const applyData = await applyReq.json();
      if (!applyReq.ok) {
        throw new Error(applyData.error || "Apply failed");
      }

      setMessage("Changes applied and CoreDNS restarted");
      await refreshDraft();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function rollbackLastApply() {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/rollback-last", { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data.error || "Rollback failed");
      }
      await refreshDraft();
      setMessage("Rollback completed from latest backup snapshot.");
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function syncFromCoreDNS() {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/sync-from-coredns", { method: "POST" });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data.error || "Sync failed");
      }
      await refreshDraft();
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setMessage(`Synced ${data.domains} domain(s) from CoreDNS files`);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openCloudflareImport() {
    if (cloudflareFileRef.current) {
      cloudflareFileRef.current.click();
    }
  }

  async function importFromCloudflareFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) {
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const content = await file.text();
      const r = await fetch("/api/import-cloudflare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, filename: file.name })
      });
      const data = await r.json();
      if (!r.ok) {
        throw new Error(data.error || "Cloudflare import failed");
      }
      await refreshDraft();
      setMessage(
        `Imported ${data.added_records || 0} record(s) from ${data.domains || 0} domain(s). Created ${
          data.created_domains || 0
        } new domain(s).`
      );
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  function updateDomain(index, patch) {
    setDomains((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function removeDomain(index) {
    const targetName = domains[index]?.name || "this domain";
    const confirmed = window.confirm(
      `Delete domain '${targetName}' and all its views/records? This cannot be undone.`
    );
    if (!confirmed) {
      return;
    }
    setDomains((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) {
        setSelectedDomainIndex(-1);
      } else if (index <= selectedDomainIndex) {
        setSelectedDomainIndex(Math.max(0, selectedDomainIndex - 1));
      }
      return next;
    });
  }

  function addDomain() {
    setDomains((prev) => {
      const next = [...prev, emptyDomain(settings)];
      setSelectedDomainIndex(next.length - 1);
      return next;
    });
  }

  function addView(domainIndex) {
    const nextId = Math.max(1, (domains[domainIndex]?.views || []).length);
    const variable = EXPRESSION_VARIABLES[0];
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: [
            ...domain.views,
            {
              name: `view${nextId}`,
              is_default: false,
              match_expression: `metadata('${variable.path}') == '${variable.defaultValue}'`,
              _expr_mode: "builder",
              _expr_rules: [makeExprRule(variable)],
              records: [emptyRecord()]
            }
          ]
        };
      })
    );
  }

  function removeView(domainIndex, viewIndex) {
    setDomains((prev) =>
      prev.map((domain, i) =>
        i === domainIndex ? { ...domain, views: domain.views.filter((_, v) => v !== viewIndex) } : domain
      )
    );
  }

  function addExprRule(domainIndex, viewIndex) {
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: domain.views.map((view, vi) => {
            if (vi !== viewIndex) {
              return view;
            }
            const base = EXPRESSION_VARIABLES[0];
            const rules = Array.isArray(view._expr_rules) ? view._expr_rules : [];
            return {
              ...view,
              _expr_rules: [...rules, makeExprRule(base)]
            };
          })
        };
      })
    );
  }

  function updateExprRule(domainIndex, viewIndex, ruleIndex, patch) {
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: domain.views.map((view, vi) => {
            if (vi !== viewIndex) {
              return view;
            }
            const rules = Array.isArray(view._expr_rules) ? view._expr_rules : [];
            return {
              ...view,
              _expr_rules: rules.map((rule, ri) => (ri === ruleIndex ? { ...rule, ...patch } : rule))
            };
          })
        };
      })
    );
  }

  function removeExprRule(domainIndex, viewIndex, ruleIndex) {
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: domain.views.map((view, vi) => {
            if (vi !== viewIndex) {
              return view;
            }
            const rules = Array.isArray(view._expr_rules) ? view._expr_rules : [];
            const nextRules = rules.filter((_, ri) => ri !== ruleIndex);
            return {
              ...view,
              _expr_rules: nextRules.length
                ? nextRules
                : [makeExprRule()]
            };
          })
        };
      })
    );
  }

  function updateView(domainIndex, viewIndex, patch) {
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: domain.views.map((view, vi) => (vi === viewIndex ? { ...view, ...patch } : view))
        };
      })
    );
  }

  function addRecord(domainIndex, viewIndex) {
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: domain.views.map((view, vi) =>
            vi === viewIndex ? { ...view, records: [...(view.records || []), emptyRecord()] } : view
          )
        };
      })
    );
  }

  function updateRecord(domainIndex, viewIndex, recordIndex, patch) {
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: domain.views.map((view, vi) => {
            if (vi !== viewIndex) {
              return view;
            }
            return {
              ...view,
              records: (view.records || []).map((record, ri) =>
                ri === recordIndex ? { ...record, ...patch } : record
              )
            };
          })
        };
      })
    );
  }

  function removeRecord(domainIndex, viewIndex, recordIndex) {
    setDomains((prev) =>
      prev.map((domain, i) => {
        if (i !== domainIndex) {
          return domain;
        }
        return {
          ...domain,
          views: domain.views.map((view, vi) => {
            if (vi !== viewIndex) {
              return view;
            }
            return { ...view, records: (view.records || []).filter((_, r) => r !== recordIndex) };
          })
        };
      })
    );
  }

  if (session.loading) {
    return <div className="container"><div className="card">Loading...</div></div>;
  }

  if (!session.authenticated) {
    if (session.setup_required) {
      return (
        <div className="auth-wrap">
          <form className="card auth-card" onSubmit={handleSetup}>
            <h1>Initial Setup</h1>
            <p className="muted">Create your admin account and default nameservers.</p>
            <label>
              Username
              <input
                value={setup.username}
                onChange={(e) => setSetup((x) => ({ ...x, username: e.target.value }))}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={setup.password}
                onChange={(e) => setSetup((x) => ({ ...x, password: e.target.value }))}
              />
            </label>
            <label>
              Confirm Password
              <input
                type="password"
                value={setup.confirmPassword}
                onChange={(e) => setSetup((x) => ({ ...x, confirmPassword: e.target.value }))}
              />
            </label>
            <label>
              Default Nameserver 1
              <input
                value={setup.nameservers[0]}
                onChange={(e) =>
                  setSetup((x) => ({ ...x, nameservers: [e.target.value, x.nameservers[1]] }))
                }
              />
            </label>
            <label>
              Default Nameserver 2
              <input
                value={setup.nameservers[1]}
                onChange={(e) =>
                  setSetup((x) => ({ ...x, nameservers: [x.nameservers[0], e.target.value] }))
                }
              />
            </label>
            <button disabled={busy}>Complete Setup</button>
            {message ? <p className="error">{message}</p> : null}
          </form>
        </div>
      );
    }

    return (
      <div className="auth-wrap">
        <form className="card auth-card" onSubmit={handleLogin}>
          <h1>GeoDNS Admin</h1>
          <p className="muted">Sign in with your admin account.</p>
          <label>
            Username
            <input
              value={login.username}
              onChange={(e) => setLogin((x) => ({ ...x, username: e.target.value }))}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={login.password}
              onChange={(e) => setLogin((x) => ({ ...x, password: e.target.value }))}
            />
          </label>
          <button disabled={busy}>Login</button>
          {message ? <p className="error">{message}</p> : null}
        </form>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="header card">
        <div>
          <h1>GeoDNS Admin Panel</h1>
          <p className="muted">Manage domains, views, records, and apply to CoreDNS.</p>
        </div>
        <div className="header-actions">
          <button className="secondary" onClick={syncFromCoreDNS} disabled={busy}>
            Sync from CoreDNS
          </button>
          <button className="secondary" onClick={handleLogout} disabled={busy}>
            Logout
          </button>
        </div>
      </div>

      <div className="card toolbar">
        <input
          ref={cloudflareFileRef}
          type="file"
          accept=".txt,.zone,.conf,.dns,text/plain"
          style={{ display: "none" }}
          onChange={importFromCloudflareFile}
        />
        <button onClick={addDomain}>Add Domain</button>
        <button className="secondary" onClick={openCloudflareImport} disabled={busy}>
          Import from Cloudflare
        </button>
        <button onClick={applyChanges} disabled={busy || hasInvalidData}>
          Apply Changes
        </button>
        <button className="secondary" onClick={rollbackLastApply} disabled={busy}>
          Rollback Last Apply
        </button>
      </div>

      <div className="card">
        <h3>Default Nameservers</h3>
        <p className="muted">
          Used only as fallback when a new view has no NS records.
        </p>
        <div className="row">
          <label className="wide">
            Nameserver 1
            <input
              value={settings.nameservers?.[0] || ""}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  nameservers: [e.target.value, prev.nameservers?.[1] || ""]
                }))
              }
              placeholder="ns1.example.com."
            />
          </label>
          <label className="wide">
            Nameserver 2
            <input
              value={settings.nameservers?.[1] || ""}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  nameservers: [prev.nameservers?.[0] || "", e.target.value]
                }))
              }
              placeholder="ns2.example.com."
            />
          </label>
          <button className="secondary" onClick={saveSettings} disabled={busy}>
            Save Nameservers
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Change Password</h3>
        <form onSubmit={handleChangePassword}>
          <div className="row">
            <label className="wide">
              Current Password
              <input
                type="password"
                value={changePassword.current}
                onChange={(e) => setChangePassword((prev) => ({ ...prev, current: e.target.value }))}
                autoComplete="current-password"
              />
            </label>
            <label className="wide">
              New Password
              <input
                type="password"
                value={changePassword.next}
                onChange={(e) => setChangePassword((prev) => ({ ...prev, next: e.target.value }))}
                autoComplete="new-password"
              />
            </label>
            <label className="wide">
              Confirm New Password
              <input
                type="password"
                value={changePassword.confirm}
                onChange={(e) => setChangePassword((prev) => ({ ...prev, confirm: e.target.value }))}
                autoComplete="new-password"
              />
            </label>
            <button className="secondary" type="submit" disabled={busy}>
              Change Password
            </button>
          </div>
          {changePassword.error ? <p className="error">{changePassword.error}</p> : null}
          {changePassword.success ? <p className="status">{changePassword.success}</p> : null}
        </form>
      </div>

      <div className="card">
        <h3>Domain Explorer</h3>
        <div className="row">
          <label className="wide">
            Search Domain
            <input
              placeholder="example.com"
              value={domainSearch}
              onChange={(e) => setDomainSearch(e.target.value)}
            />
          </label>
          <label className="wide">
            Select Domain
            <select
              value={String(selectedDomainIndex)}
              onChange={(e) => setSelectedDomainIndex(Number(e.target.value))}
              disabled={!filteredDomainOptions.length}
            >
              {!filteredDomainOptions.length ? (
                <option value="-1">No matching domain</option>
              ) : (
                filteredDomainOptions.map(({ domain, index }) => (
                  <option key={`${domain.name}-${index}`} value={index}>
                    {domain.name || "(new domain)"}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>
      </div>

      {message ? <p className="status">{message}</p> : null}
      {warnings.map((warning, index) => (
        <div className="card warning" key={`warning-${index}`}>
          {warning}
        </div>
      ))}
      {domains.length === 0 ? (
        <div className="card empty">No domains loaded yet. Add one or sync from CoreDNS.</div>
      ) : null}

      {domains
        .map((domain, domainIndex) => ({ domain, domainIndex }))
        .filter(({ domainIndex }) => domainIndex === selectedDomainIndex)
        .map(({ domain, domainIndex }) => {
          return (
        <div className="card domain" key={`domain-${domainIndex}`}>
          <div className="row domain-row">
            <label>
              Domain
              <input
                value={domain.name}
                onChange={(e) => updateDomain(domainIndex, { name: e.target.value.toLowerCase() })}
              />
            </label>
            <label>
              Default TTL
              <input
                type="number"
                value={domain.default_ttl}
                onChange={(e) =>
                  updateDomain(domainIndex, { default_ttl: Number(e.target.value || 300) })
                }
              />
            </label>
            <button className="danger" onClick={() => removeDomain(domainIndex)}>
              Delete Domain
            </button>
          </div>

          <div className="views">
            {(domain.views || []).map((view, viewIndex) => (
              <div className="view" key={`view-${viewIndex}`}>
                <div className="row">
                  <label>
                    View Name
                    <input
                      value={view.name}
                      disabled={view.is_default}
                      onChange={(e) => updateView(domainIndex, viewIndex, { name: e.target.value })}
                    />
                  </label>

                  {view.is_default ? (
                    <div className="hint strong">Default fallback view</div>
                  ) : (
                    <>
                      <label>
                        Expression Mode
                        <select
                          value={view._expr_mode || "manual"}
                          onChange={(e) => updateView(domainIndex, viewIndex, { _expr_mode: e.target.value })}
                        >
                          <option value="manual">Manual</option>
                          <option value="builder">Builder</option>
                        </select>
                      </label>

                      {(view._expr_mode || "manual") === "builder" ? (
                        <>
                          <div className="expr-rules">
                            {(view._expr_rules || []).map((rule, ruleIndex) => (
                              <div className="expr-rule" key={`rule-${ruleIndex}`}>
                                {ruleIndex > 0 ? (
                                  <select
                                    value={rule.join || "&&"}
                                    onChange={(e) =>
                                      updateExprRule(domainIndex, viewIndex, ruleIndex, {
                                        join: e.target.value
                                      })
                                    }
                                  >
                                    <option value="&&">&&</option>
                                    <option value="||">||</option>
                                  </select>
                                ) : (
                                  <div className="expr-first">IF</div>
                                )}
                                <select
                                  value={String(rule.openParen || 0)}
                                  onChange={(e) =>
                                    updateExprRule(domainIndex, viewIndex, ruleIndex, {
                                      openParen: Number(e.target.value)
                                    })
                                  }
                                >
                                  <option value="0">no (</option>
                                  <option value="1">(</option>
                                  <option value="2">((</option>
                                  <option value="3">(((</option>
                                </select>
                                <select
                                  value={rule.path || EXPRESSION_VARIABLES[0].path}
                                  onChange={(e) => {
                                    const selected = EXPRESSION_VARIABLES.find(
                                      (item) => item.path === e.target.value
                                    );
                                    updateExprRule(domainIndex, viewIndex, ruleIndex, {
                                      path: e.target.value,
                                      value: rule.value || selected?.defaultValue || "US"
                                    });
                                  }}
                                >
                                  {EXPRESSION_VARIABLES.map((item) => (
                                    <option key={item.id} value={item.path}>
                                      {item.label}
                                    </option>
                                  ))}
                                </select>
                                <select
                                  value={rule.operator || "=="}
                                  onChange={(e) =>
                                    updateExprRule(domainIndex, viewIndex, ruleIndex, {
                                      operator: e.target.value
                                    })
                                  }
                                >
                                  <option value="==">==</option>
                                  <option value="!=">!=</option>
                                </select>
                                <input
                                  value={rule.value || ""}
                                  onChange={(e) =>
                                    updateExprRule(domainIndex, viewIndex, ruleIndex, {
                                      value: e.target.value
                                    })
                                  }
                                  placeholder="US"
                                />
                                <select
                                  value={String(rule.closeParen || 0)}
                                  onChange={(e) =>
                                    updateExprRule(domainIndex, viewIndex, ruleIndex, {
                                      closeParen: Number(e.target.value)
                                    })
                                  }
                                >
                                  <option value="0">no )</option>
                                  <option value="1">)</option>
                                  <option value="2">))</option>
                                  <option value="3">)))</option>
                                </select>
                                <button
                                  className="danger"
                                  type="button"
                                  onClick={() => removeExprRule(domainIndex, viewIndex, ruleIndex)}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() => addExprRule(domainIndex, viewIndex)}
                          >
                            Add Condition
                          </button>
                          <div className="hint mono">{buildExpressionFromView(view) || "Expression is empty"}</div>
                        </>
                      ) : (
                        <label className="wide">
                          Match Expression (CoreDNS view expr)
                          <input
                            placeholder="metadata('geoip/country/code') == 'US'"
                            value={view.match_expression || ""}
                            onChange={(e) =>
                              updateView(domainIndex, viewIndex, { match_expression: e.target.value })
                            }
                          />
                        </label>
                      )}
                    </>
                  )}

                  {!view.is_default ? (
                    <button className="danger" onClick={() => removeView(domainIndex, viewIndex)}>
                      Delete View
                    </button>
                  ) : null}
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Value</th>
                        <th>TTL</th>
                        <th>Priority</th>
                        <th>Weight</th>
                        <th>Port</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {(view.records || []).map((record, recordIndex) => (
                        <tr key={`record-${recordIndex}`}>
                          <td>
                            <input
                              value={record.name}
                              onChange={(e) =>
                                updateRecord(domainIndex, viewIndex, recordIndex, { name: e.target.value })
                              }
                            />
                          </td>
                          <td>
                            <select
                              value={record.type}
                              onChange={(e) =>
                                updateRecord(domainIndex, viewIndex, recordIndex, { type: e.target.value })
                              }
                            >
                              {["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "PTR"].map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              value={record.value}
                              onChange={(e) =>
                                updateRecord(domainIndex, viewIndex, recordIndex, { value: e.target.value })
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              value={record.ttl}
                              onChange={(e) =>
                                updateRecord(domainIndex, viewIndex, recordIndex, { ttl: e.target.value })
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              value={record.priority}
                              onChange={(e) =>
                                updateRecord(domainIndex, viewIndex, recordIndex, {
                                  priority: e.target.value
                                })
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              value={record.weight}
                              onChange={(e) =>
                                updateRecord(domainIndex, viewIndex, recordIndex, { weight: e.target.value })
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              value={record.port}
                              onChange={(e) =>
                                updateRecord(domainIndex, viewIndex, recordIndex, { port: e.target.value })
                              }
                            />
                          </td>
                          <td>
                            <button
                              className="danger"
                              onClick={() => removeRecord(domainIndex, viewIndex, recordIndex)}
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button className="secondary" onClick={() => addRecord(domainIndex, viewIndex)}>
                  Add Record
                </button>
              </div>
            ))}
          </div>
          <button className="secondary" onClick={() => addView(domainIndex)}>
            Add Geo View
          </button>
        </div>
          );
        })}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
