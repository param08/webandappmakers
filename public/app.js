const $ = s => document.querySelector(s);
const api = (u, o) => fetch(u, { headers: { "Content-Type": "application/json" }, ...o }).then(r => r.json());

async function init() {
  const me = await api("/api/me");
  if (!me.connected) { $("#connectCard").style.display = "block"; $("#who").textContent = "not connected"; return; }
  $("#app").style.display = "block";
  $("#who").textContent = "@" + (me.ig_username || me.ig_user_id);
  await Promise.all([loadStats(), loadRules()]);
}

async function loadStats() {
  const { stats } = await api("/api/stats");
  $("#stats").innerHTML = [
    ["Total handled", stats.total || 0],
    ["Comments", stats.comments || 0],
    ["Incoming DMs", stats.incoming_dms || 0],
    ["Public replies", stats.public_replies || 0],
    ["DMs sent", stats.dms || 0],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span class="muted">${k}</span></div>`).join("");
}

let RULES = [];
async function loadRules() { RULES = await api("/api/rules"); renderRules(); }

function renderRules() {
  $("#rules").innerHTML = RULES.map(r => ruleHtml(r)).join("") || '<p class="muted">No rules yet.</p>';
}

function ruleHtml(r) {
  const kw = (r.keywords || []).join(", ");
  return `<div class="rule" data-id="${r.id}">
    <div class="row">
      <div><label>Name</label><input value="${esc(r.name)}" oninput="patch(${r.id},'name',this.value)"></div>
      <div><label>Match</label>
        <select onchange="patch(${r.id},'type',this.value)">
          <option value="kw" ${r.type==='kw'?'selected':''}>Keywords</option>
          <option value="any" ${r.type==='any'?'selected':''}>Everything</option>
        </select></div>
      <div><label>Channel</label>
        <select onchange="patch(${r.id},'channel',this.value)">
          <option value="both" ${r.channel==='both'?'selected':''}>Comments + DMs</option>
          <option value="comment" ${r.channel==='comment'?'selected':''}>Comments only</option>
          <option value="dm" ${r.channel==='dm'?'selected':''}>DMs only</option>
        </select></div>
    </div>
    <label>Keywords (comma separated)</label>
    <input value="${esc(kw)}" ${r.type==='any'?'disabled':''} oninput="patch(${r.id},'keywords',this.value.split(',').map(s=>s.trim()).filter(Boolean))">
    <div class="row">
      <div><label><input type="checkbox" style="width:auto" ${r.do_public?'checked':''} onchange="patch(${r.id},'do_public',this.checked)"> Public comment reply</label>
        <textarea rows="2" oninput="patch(${r.id},'public_text',this.value)">${esc(r.public_text)}</textarea></div>
      <div><label><input type="checkbox" style="width:auto" ${r.do_dm?'checked':''} onchange="patch(${r.id},'do_dm',this.checked)"> DM — ${r.gated?'main message (held until they follow)':'auto reply'}</label>
        <textarea rows="2" oninput="patch(${r.id},'dm_text',this.value)">${esc(r.dm_text)}</textarea></div>
    </div>
    <div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:10px">
      <label><input type="checkbox" style="width:auto" ${r.gated?'checked':''} onchange="patch(${r.id},'gated',this.checked);renderAfter(${r.id})"> <b>Follow gate</b> — send a Follow button first, hold the main message until they reply back</label>
      <div class="${r.gated?'':'hidden'}" style="${r.gated?'':'display:none'}">
        <label>Step 1 — Follow ask (shown with the Follow button)</label>
        <textarea rows="2" oninput="patch(${r.id},'follow_text',this.value)">${esc(r.follow_text)}</textarea>
        <label>Follow button link (leave blank to use your own profile)</label>
        <input value="${esc(r.follow_url)}" placeholder="https://instagram.com/yourhandle" oninput="patch(${r.id},'follow_url',this.value)">
        <p class="muted" style="margin:6px 0 0">Note: Instagram can't confirm a follow. The main message is released when they message you again after tapping Follow.</p>
      </div>
    </div>
    <div class="row" style="margin-top:10px;align-items:center">
      <div><label><input type="checkbox" style="width:auto" ${r.enabled?'checked':''} onchange="toggle(${r.id},this.checked)"> Enabled</label></div>
      <div style="text-align:right;flex:0"><button onclick="save(${r.id})" class="primary">Save</button>
      <button onclick="del(${r.id})">Delete</button></div>
    </div>
  </div>`;
}

function esc(s){return String(s||"").replace(/"/g,'&quot;').replace(/</g,'&lt;')}
function find(id){return RULES.find(r=>r.id===id)}
function patch(id,k,v){const r=find(id);if(r)r[k]=v;}
function renderAfter(){renderRules();}
async function save(id){const r=find(id);await api("/api/rules/"+id,{method:"PUT",body:JSON.stringify(r)});await loadRules();}
async function toggle(id,on){await api("/api/rules/"+id+"/toggle",{method:"POST",body:JSON.stringify({enabled:on})});}
async function del(id){await api("/api/rules/"+id,{method:"DELETE"});await loadRules();}
async function newRule(){
  await api("/api/rules",{method:"POST",body:JSON.stringify({name:"New rule",type:"kw",keywords:[],channel:"both",do_public:1,public_text:"Thanks! Check your DMs 🙌",do_dm:1,dm_text:"Hi! Here are the details…",gated:0,follow_text:"Make sure you're following us first 👇 then reply here and I'll send the details.",follow_url:"",enabled:0})});
  await loadRules();
}
init();
