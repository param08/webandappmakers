// server.js — webandappmakers: multi-tenant Instagram comment + DM auto-reply
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const store = require("./db");

// Instagram API with Instagram Login (no Facebook Page required)
const IG_GRAPH = "https://graph.instagram.com/v23.0";
const {
  APP_ID, APP_SECRET, VERIFY_TOKEN,
  BASE_URL, SESSION_SECRET, PORT = 3000,
} = process.env;

const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
].join(",");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 },
}));
app.use(express.static(__dirname + "/public"));

// ---------- helpers ----------
async function graph(path, { method = "GET", token, body } = {}) {
  const url = new URL(IG_GRAPH + path);
  if (token) url.searchParams.set("access_token", token);
  const opts = { method };
  if (body) { opts.headers = { "Content-Type": "application/json" }; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(json.error || json));
  return json;
}

function requireAccount(req, res, next) {
  if (!req.session.accountId) return res.status(401).json({ error: "not_connected" });
  const acc = store.getAccountById(req.session.accountId);
  if (!acc) { req.session.accountId = null; return res.status(401).json({ error: "not_connected" }); }
  req.account = acc;
  next();
}

function matchRule(text, rules) {
  const t = (text || "").toLowerCase();
  // keyword rules first, then catch-all ('any')
  for (const r of rules.filter(r => r.type === "kw")) {
    if (r.keywords.some(k => k && t.includes(k))) return r;
  }
  return rules.find(r => r.type === "any") || null;
}

function profileUrl(acc, rule) {
  if (rule && rule.follow_url) return rule.follow_url;
  if (acc.ig_username) return `https://instagram.com/${acc.ig_username}`;
  return "https://instagram.com";
}

// plain text DM to a user id
function sendDM(igId, token, recipientId, text) {
  return graph(`/${igId}/messages`, { method: "POST", token,
    body: { recipient: { id: recipientId }, message: { text } } });
}

// Follow ask: try a tappable button template; fall back to plain text + link if IG rejects it.
async function sendFollowButton(igId, token, recipientId, text, url) {
  const body = {
    recipient: { id: recipientId },
    message: { attachment: { type: "template", payload: {
      template_type: "button",
      text: text || "Follow us first 👇",
      buttons: [{ type: "web_url", url, title: "Follow us" }],
    } } },
  };
  try {
    return await graph(`/${igId}/messages`, { method: "POST", token, body });
  } catch (e) {
    console.error("button template failed, sending text:", e.message);
    return sendDM(igId, token, recipientId, `${text || "Make sure you're following us first 👇"}\n${url}`);
  }
}

// ---------- OAuth ----------
app.get("/connect", (req, res) => {
  const redirect = `${BASE_URL}/auth/callback`;
  const url = `https://www.instagram.com/oauth/authorize?client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent(SCOPES)}`;
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    let { code } = req.query;
    if (!code) return res.status(400).send("Missing authorization code.");
    code = String(code).replace(/#_$/, ""); // IG appends a trailing #_

    const redirect = `${BASE_URL}/auth/callback`;

    // 1) code -> short-lived Instagram user token (form POST to api.instagram.com)
    const form = new URLSearchParams({
      client_id: APP_ID, client_secret: APP_SECRET,
      grant_type: "authorization_code", redirect_uri: redirect, code,
    });
    const sRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form,
    });
    const sJson = await sRes.json().catch(() => ({}));
    if (!sRes.ok) throw new Error("short-token: " + JSON.stringify(sJson));
    const first = Array.isArray(sJson.data) ? sJson.data[0] : sJson;
    const shortToken = first.access_token;
    const igUserId = String(first.user_id);

    // 2) short -> long-lived token (~60 days)
    const lRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(shortToken)}`);
    const lJson = await lRes.json().catch(() => ({}));
    if (!lRes.ok) throw new Error("long-token: " + JSON.stringify(lJson));
    const token = lJson.access_token;

    // 3) who is this? (username)
    let username = null;
    try {
      const me = await graph(`/me?fields=user_id,username`, { token });
      username = me.username || null;
    } catch (e) { console.error("me:", e.message); }

    const acc = store.upsertAccount({
      ig_user_id: igUserId, ig_username: username, page_id: null, access_token: token,
    });
    store.seedRules(acc.id);

    // 4) subscribe this IG account to comment + message webhooks
    try {
      await graph(`/${igUserId}/subscribed_apps?subscribed_fields=comments,messages`, { method: "POST", token });
    } catch (e) { console.error("subscribe error:", e.message); }

    req.session.accountId = acc.id;
    res.redirect("/");
  } catch (e) {
    console.error("auth error:", e.message);
    res.status(500).send("Auth failed: " + e.message);
  }
});

app.post("/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

// ---------- Webhook ----------
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200); // ack fast
  handleEvent(req.body).catch(e => console.error("handleEvent:", e.message));
});

async function handleEvent(body) {
  if (!body || !Array.isArray(body.entry)) return;
  for (const entry of body.entry) {
    // IG comment webhooks arrive under entry.changes
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        if (change.field === "comments") await onComment(entry.id, change.value);
      }
    }
    // IG DM webhooks arrive under entry.messaging
    if (Array.isArray(entry.messaging)) {
      for (const m of entry.messaging) await onMessage(entry.id, m);
    }
  }
}

async function onComment(igId, c) {
  const acc = store.getAccountByIg(igId);
  if (!acc || !c || !c.id) return;
  if (store.alreadyHandled(c.id)) return;
  // ignore the business replying to itself
  if (c.from && String(c.from.id) === String(igId)) return;

  const rules = store.enabledRules(acc.id, "comment");
  const rule = matchRule(c.text, rules);
  if (!rule) return;

  let didPublic = 0, didDm = 0, error = null;
  try {
    if (rule.do_public && rule.public_text) {
      await graph(`/${c.id}/replies`, { method: "POST", token: acc.access_token, body: { message: rule.public_text } });
      didPublic = 1;
    }
    if (rule.do_dm) {
      // private reply to a comment: recipient = comment_id (we don't yet know the user's id here)
      if (rule.gated) {
        // Step 1 (comment origin): private reply with ONLY the follow ask + profile link.
        // We don't have the user's messaging id from a comment, so we send to comment_id and
        // the gate completes when they open a DM (handled in onMessage).
        await graph(`/${igId}/messages`, { method: "POST", token: acc.access_token,
          body: { recipient: { comment_id: c.id }, message: { text:
            (rule.follow_text || "Make sure you're following us first 👇 then reply here and I'll send the details.")
            + "\n" + profileUrl(acc, rule) } } });
        didDm = 1;
      } else if (rule.dm_text || rule.public_text) {
        await graph(`/${igId}/messages`, { method: "POST", token: acc.access_token,
          body: { recipient: { comment_id: c.id }, message: { text: rule.dm_text || rule.public_text } } });
        didDm = 1;
      }
    }
  } catch (e) { error = e.message; console.error("comment reply:", e.message); }
  store.logAction({ account_id: acc.id, kind: "comment", event_id: c.id, rule_id: rule.id, text: c.text, did_public: didPublic, did_dm: didDm, error });
}

async function onMessage(igId, m) {
  const acc = store.getAccountByIg(igId);
  if (!acc || !m || !m.message) return;
  if (m.message.is_echo) return;                 // skip our own outgoing messages
  const mid = m.message.mid;
  if (!mid || store.alreadyHandled(mid)) return;
  const senderId = m.sender && m.sender.id;
  if (!senderId || String(senderId) === String(igId)) return;

  const text = m.message.text || "";

  // --- Follow gate: is this person coming back after we asked them to follow? ---
  const pend = store.getPending(acc.id, senderId);
  if (pend) {
    // They replied after the follow ask → release the held main message now.
    let didDm = 0, error = null;
    try {
      if (pend.payload) { await sendDM(igId, acc.access_token, senderId, pend.payload); didDm = 1; }
    } catch (e) { error = e.message; console.error("gate release:", e.message); }
    store.clearPending(acc.id, senderId);
    store.logAction({ account_id: acc.id, kind: "dm", event_id: mid, rule_id: pend.rule_id, text, did_public: 0, did_dm: didDm, error });
    return;
  }

  const rules = store.enabledRules(acc.id, "dm");
  const rule = matchRule(text, rules);
  if (!rule) return;

  let didDm = 0, error = null;
  try {
    if (rule.gated) {
      // Step 1: send the Follow button and HOLD the main message. Release it when they reply again.
      await sendFollowButton(igId, acc.access_token, senderId,
        rule.follow_text || "Make sure you're following us first 👇 then reply here and I'll send the details.",
        profileUrl(acc, rule));
      store.setPending({ account_id: acc.id, sender_id: senderId, rule_id: rule.id,
        payload: rule.dm_text || rule.public_text || "" });
      didDm = 1;
    } else {
      const replyText = rule.dm_text || rule.public_text;
      if (replyText) { await sendDM(igId, acc.access_token, senderId, replyText); didDm = 1; }
    }
  } catch (e) { error = e.message; console.error("dm reply:", e.message); }
  store.logAction({ account_id: acc.id, kind: "dm", event_id: mid, rule_id: rule.id, text, did_public: 0, did_dm: didDm, error });
}

// ---------- API (dashboard) ----------
app.get("/api/me", (req, res) => {
  if (!req.session.accountId) return res.json({ connected: false });
  const acc = store.getAccountById(req.session.accountId);
  if (!acc) return res.json({ connected: false });
  res.json({ connected: true, ig_username: acc.ig_username, ig_user_id: acc.ig_user_id });
});

app.get("/api/rules", requireAccount, (req, res) => res.json(store.listRules(req.account.id)));
app.post("/api/rules", requireAccount, (req, res) => {
  const id = store.createRule({ ...req.body, account_id: req.account.id });
  res.json({ id });
});
app.put("/api/rules/:id", requireAccount, (req, res) => {
  store.updateRule({ ...req.body, id: +req.params.id, account_id: req.account.id });
  res.json({ ok: true });
});
app.post("/api/rules/:id/toggle", requireAccount, (req, res) => {
  store.setEnabled(+req.params.id, req.account.id, !!req.body.enabled);
  res.json({ ok: true });
});
app.delete("/api/rules/:id", requireAccount, (req, res) => {
  store.deleteRule(+req.params.id, req.account.id);
  res.json({ ok: true });
});

app.get("/api/stats", requireAccount, (req, res) => {
  res.json({ stats: store.stats(req.account.id), recent: store.recentLogs(req.account.id) });
});

app.listen(PORT, () => console.log(`webandappmakers running on :${PORT}`));
