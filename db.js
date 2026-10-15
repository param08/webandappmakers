// db.js — SQLite storage for webandappmakers auto-reply
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ig_user_id    TEXT UNIQUE NOT NULL,
  ig_username   TEXT,
  page_id       TEXT,
  access_token  TEXT NOT NULL,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  name        TEXT,
  type        TEXT DEFAULT 'kw',          -- 'kw' = keyword match, 'any' = match everything
  keywords    TEXT DEFAULT '[]',          -- JSON array of lowercased keywords
  channel     TEXT DEFAULT 'both',        -- 'comment' | 'dm' | 'both'
  do_public   INTEGER DEFAULT 1,          -- post a public reply on comments
  public_text TEXT DEFAULT '',
  do_dm       INTEGER DEFAULT 1,          -- send a DM
  dm_text     TEXT DEFAULT '',            -- the MAIN message (link/offer) — held back when gated
  gated       INTEGER DEFAULT 0,          -- two-step follow gate: ask to follow first, hold main msg
  follow_text TEXT DEFAULT '',            -- step 1 message shown with the Follow button
  follow_url  TEXT DEFAULT '',            -- URL behind the Follow button (defaults to the profile)
  enabled     INTEGER DEFAULT 1,
  sort        INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pending (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  sender_id   TEXT NOT NULL,              -- IG-scoped id of the person we asked to follow
  rule_id     INTEGER,
  payload     TEXT,                       -- the main message to release on their next reply
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, sender_id)
);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  INTEGER NOT NULL,
  kind        TEXT DEFAULT 'comment',     -- 'comment' | 'dm'
  event_id    TEXT UNIQUE,                -- comment id or message mid (dedupe key)
  rule_id     INTEGER,
  text        TEXT,
  did_public  INTEGER DEFAULT 0,
  did_dm      INTEGER DEFAULT 0,
  error       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
`);

// --- accounts ---
const _upsert = db.prepare(`
  INSERT INTO accounts (ig_user_id, ig_username, page_id, access_token)
  VALUES (@ig_user_id, @ig_username, @page_id, @access_token)
  ON CONFLICT(ig_user_id) DO UPDATE SET
    ig_username = excluded.ig_username,
    page_id     = excluded.page_id,
    access_token= excluded.access_token
`);
function upsertAccount(a) {
  _upsert.run(a);
  return getAccountByIg(a.ig_user_id);
}
const _byIg = db.prepare("SELECT * FROM accounts WHERE ig_user_id = ?");
function getAccountByIg(ig) { return _byIg.get(ig); }
const _byId = db.prepare("SELECT * FROM accounts WHERE id = ?");
function getAccountById(id) { return _byId.get(id); }

// --- rules ---
const _list = db.prepare("SELECT * FROM rules WHERE account_id = ? ORDER BY sort, id");
function listRules(accId) {
  return _list.all(accId).map(r => ({ ...r, keywords: JSON.parse(r.keywords || "[]") }));
}
function enabledRules(accId, channel) {
  return listRules(accId).filter(r =>
    r.enabled && (r.channel === "both" || r.channel === channel));
}
const _create = db.prepare(`
  INSERT INTO rules (account_id,name,type,keywords,channel,do_public,public_text,do_dm,dm_text,gated,follow_text,follow_url,enabled,sort)
  VALUES (@account_id,@name,@type,@keywords,@channel,@do_public,@public_text,@do_dm,@dm_text,@gated,@follow_text,@follow_url,@enabled,@sort)
`);
function createRule(r) {
  const info = _create.run({
    account_id: r.account_id,
    name: r.name || "Untitled rule",
    type: r.type || "kw",
    keywords: JSON.stringify((r.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean)),
    channel: r.channel || "both",
    do_public: r.do_public ? 1 : 0,
    public_text: r.public_text || "",
    do_dm: r.do_dm ? 1 : 0,
    dm_text: r.dm_text || "",
    gated: r.gated ? 1 : 0,
    follow_text: r.follow_text || "",
    follow_url: r.follow_url || "",
    enabled: r.enabled === 0 ? 0 : 1,
    sort: r.sort || 0,
  });
  return info.lastInsertRowid;
}
const _update = db.prepare(`
  UPDATE rules SET name=@name,type=@type,keywords=@keywords,channel=@channel,
    do_public=@do_public,public_text=@public_text,do_dm=@do_dm,dm_text=@dm_text,
    gated=@gated,follow_text=@follow_text,follow_url=@follow_url,enabled=@enabled
  WHERE id=@id AND account_id=@account_id
`);
function updateRule(r) {
  _update.run({
    id: r.id, account_id: r.account_id,
    name: r.name || "Untitled rule",
    type: r.type || "kw",
    keywords: JSON.stringify((r.keywords || []).map(k => String(k).toLowerCase().trim()).filter(Boolean)),
    channel: r.channel || "both",
    do_public: r.do_public ? 1 : 0,
    public_text: r.public_text || "",
    do_dm: r.do_dm ? 1 : 0,
    dm_text: r.dm_text || "",
    gated: r.gated ? 1 : 0,
    follow_text: r.follow_text || "",
    follow_url: r.follow_url || "",
    enabled: r.enabled ? 1 : 0,
  });
}
const _setEnabled = db.prepare("UPDATE rules SET enabled=? WHERE id=? AND account_id=?");
function setEnabled(id, accId, on) { _setEnabled.run(on ? 1 : 0, id, accId); }
const _del = db.prepare("DELETE FROM rules WHERE id=? AND account_id=?");
function deleteRule(id, accId) { _del.run(id, accId); }

// --- logs ---
const _log = db.prepare(`
  INSERT OR IGNORE INTO logs (account_id,kind,event_id,rule_id,text,did_public,did_dm,error)
  VALUES (@account_id,@kind,@event_id,@rule_id,@text,@did_public,@did_dm,@error)
`);
function logAction(l) {
  _log.run({
    account_id: l.account_id, kind: l.kind || "comment", event_id: l.event_id,
    rule_id: l.rule_id || null, text: l.text || "",
    did_public: l.did_public ? 1 : 0, did_dm: l.did_dm ? 1 : 0,
    error: l.error || null,
  });
}
const _seen = db.prepare("SELECT 1 FROM logs WHERE event_id = ?");
function alreadyHandled(eventId) { return !!_seen.get(eventId); }

// --- pending (follow gate) ---
const _setPending = db.prepare(`
  INSERT INTO pending (account_id,sender_id,rule_id,payload)
  VALUES (@account_id,@sender_id,@rule_id,@payload)
  ON CONFLICT(account_id,sender_id) DO UPDATE SET
    rule_id = excluded.rule_id, payload = excluded.payload, created_at = datetime('now')
`);
function setPending(p) { _setPending.run(p); }
const _getPending = db.prepare("SELECT * FROM pending WHERE account_id=? AND sender_id=?");
function getPending(accId, senderId) { return _getPending.get(accId, senderId); }
const _clearPending = db.prepare("DELETE FROM pending WHERE account_id=? AND sender_id=?");
function clearPending(accId, senderId) { _clearPending.run(accId, senderId); }

const _stats = db.prepare(`
  SELECT
    COUNT(*)                                   AS total,
    COALESCE(SUM(did_public),0)                AS public_replies,
    COALESCE(SUM(did_dm),0)                     AS dms,
    COALESCE(SUM(CASE WHEN kind='comment' THEN 1 ELSE 0 END),0) AS comments,
    COALESCE(SUM(CASE WHEN kind='dm' THEN 1 ELSE 0 END),0)      AS incoming_dms
  FROM logs WHERE account_id = ?
`);
function stats(accId) { return _stats.get(accId) || {}; }
const _recent = db.prepare("SELECT * FROM logs WHERE account_id=? ORDER BY id DESC LIMIT 25");
function recentLogs(accId) { return _recent.all(accId); }

function seedRules(accId) {
  if (listRules(accId).length) return;
  createRule({ account_id: accId, name: "Follow-gated pricing / info", type: "kw",
    keywords: ["price", "cost", "info", "how much", "dm", "link"], channel: "both",
    do_public: 1, public_text: "Thanks for reaching out! 🙌 Check your DMs 👇",
    do_dm: 1,
    gated: 1,
    follow_text: "Hey! Make sure you're following us first 👇 then reply here and I'll send you the details.",
    follow_url: "", // defaults to the connected profile
    dm_text: "Awesome — here are the details you asked for. Reply here and a human will follow up. 🙏",
    enabled: 1, sort: 0 });
  createRule({ account_id: accId, name: "Catch-all auto reply", type: "any",
    keywords: [], channel: "both",
    do_public: 0, public_text: "",
    do_dm: 1, gated: 0, follow_text: "", follow_url: "",
    dm_text: "Thanks for your message! We'll get back to you shortly. 🙏",
    enabled: 0, sort: 1 });
}

module.exports = {
  db, upsertAccount, getAccountByIg, getAccountById,
  listRules, enabledRules, createRule, updateRule, setEnabled, deleteRule,
  logAction, alreadyHandled, stats, recentLogs, seedRules,
  setPending, getPending, clearPending,
};
