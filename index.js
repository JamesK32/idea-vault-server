// index.js
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.urlencoded({ extended: false })); // for Twilio-style bodies
app.use(express.json());                            // for JSON bodies

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Simple API key check (header: x-api-key or ?key=)
function checkKey(req) {
  const k = req.headers['x-api-key'] || req.query.key;
  return k && process.env.API_KEY && k === process.env.API_KEY;
}

// Health
app.get('/', (_, res) => res.send('ok'));

// ---------- Optional: SMS webhook you set up earlier ----------
function guessType(text = '', hasMedia = false) {
  if (/^\s*idea[:\-]/i.test(text)) return 'idea';
  if (/^\s*(contact|person)[:\-]/i.test(text)) return 'person';
  if (/^\s*tool[:\-]/i.test(text)) return 'tool';
  if (hasMedia) return 'tool';
  return 'unknown';
}

app.post('/twilio/webhook', async (req, res) => {
  try {
    const from = req.body.From || '';
    const body = req.body.Body || '';
    const mediaCount = Number(req.body.NumMedia || 0);

    const media = [];
    for (let i = 0; i < mediaCount; i++) {
      media.push({
        url: req.body[`MediaUrl${i}`],
        type: req.body[`MediaContentType${i}`]
      });
    }

    // Log raw message
    await supabase.from('ingestion_event').insert({
      from_number: from,
      body,
      media
    });

    // Create a record in the right table
    const type = guessType(body, mediaCount > 0);

    if (type === 'idea') {
      const cleaned = body.replace(/^.*?idea[:\-]\s*/i, '');
      const [firstLine, ...rest] = cleaned.split('\n');
      await supabase.from('idea').insert({
        title: (firstLine || 'Untitled Idea').trim(),
        summary: rest.join('\n').trim() || null
      });
    } else if (type === 'person') {
      const cleaned = body.replace(/^.*?(contact|person)[:\-]\s*/i, '');
      const parts = cleaned.split(',').map(s => s.trim());
      await supabase.from('person').insert({
        name: parts[0] || 'Unknown',
        phone: parts.find(p => /\d{3}.*\d{4}/.test(p)) || null,
        email: parts.find(p => /@/.test(p)) || null,
        company: parts[3] || null,
        role: parts[4] || null,
        location: parts[5] || null
      });
    } else if (type === 'tool') {
      const cleaned = body.replace(/^.*?tool[:\-]\s*/i, '');
      const [name, url, description] = cleaned.split('|').map(s => s && s.trim());
      await supabase.from('tool').insert({
        name: name || 'Unknown Tool',
        url: url || null,
        description: description || null
      });
    }

    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (err) {
    console.error(err);
    res.status(500).send('<Response></Response>');
  }
});
// --------------------------------------------------------------

// Quick Add API (idea / person / tool)
app.post('/api/quick-add', async (req, res) => {
  try {
    if (!checkKey(req)) return res.status(401).json({ error: 'bad key' });

    const { type, payload } = req.body || {};
    if (!type) return res.status(400).json({ error: 'missing type' });

    if (type === 'idea') {
      const { title, summary } = payload || {};
      if (!title) return res.status(400).json({ error: 'title required' });
      await supabase.from('idea').insert({ title, summary: summary || null });
      return res.json({ ok: true, type });
    }

    if (type === 'person') {
      const { name, phone, email, company, role, school, location } = payload || {};
      if (!name) return res.status(400).json({ error: 'name required' });
      await supabase.from('person').insert({ name, phone, email, company, role, school, location });
      return res.json({ ok: true, type });
    }

    if (type === 'tool') {
      const { name, url, category, description } = payload || {};
      if (!name) return res.status(400).json({ error: 'name required' });
      await supabase.from('tool').insert({ name, url, category, description });
      return res.json({ ok: true, type });
    }

    return res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
});

// Research Add API (note / ref / fact) for an Idea
// body: { rtype: 'note'|'ref'|'fact', idea_title: '...',
//         note?, source_url?, source_title?, fact?, confidence? }
app.post('/api/research-add', async (req, res) => {
  try {
    if (!checkKey(req)) return res.status(401).json({ error: 'bad key' });

    const { rtype, idea_title, note, source_url, source_title, fact, confidence } = req.body || {};
    if (!rtype || !idea_title) return res.status(400).json({ error: 'missing rtype or idea_title' });

    // find existing idea by title or create it
    async function getIdeaId(title) {
      const found = await supabase
        .from('idea')
        .select('id')
        .eq('title', title)
        .order('created_at', { ascending: false })
        .limit(1);

      if (found.error) throw found.error;
      if (found.data && found.data[0]) return found.data[0].id;

      const ins = await supabase.from('idea').insert({ title }).select('id').single();
      if (ins.error) throw ins.error;
      return ins.data.id;
    }

    const ideaId = await getIdeaId(String(idea_title).trim());

    if (rtype === 'note') {
      if (!note) return res.status(400).json({ error: 'note required' });
      const r = await supabase.from('idea_note').insert({ idea_id: ideaId, content: String(note) });
      if (r.error) throw r.error;
      return res.json({ ok: true, rtype });
    }

    if (rtype === 'ref') {
      if (!source_url && !source_title)
        return res.status(400).json({ error: 'source_url or source_title required' });
      const r = await supabase.from('idea_source').insert({
        idea_id: ideaId,
        kind: source_url ? 'url' : 'other',
        url: source_url || null,
        title: source_title || null
      });
      if (r.error) throw r.error;
      return res.json({ ok: true, rtype });
    }

    if (rtype === 'fact') {
      if (!fact) return res.status(400).json({ error: 'fact (statement) required' });
      const r = await supabase.from('idea_fact').insert({
        idea_id: ideaId,
        statement: String(fact),
        source_url: source_url || null,
        confidence: Number(confidence) || null
      });
      if (r.error) throw r.error;
      return res.json({ ok: true, rtype });
    }

    return res.status(400).json({ error: 'unknown rtype' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server error' });
  }
});

// Quick Add Web Form (with Research section)
app.get('/add', (_req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Idea Vault — Quick Add</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:24px auto;padding:0 12px}
  h1{font-size:22px}
  fieldset{border:1px solid #ddd;border-radius:12px;padding:12px;margin:12px 0}
  input,textarea{width:100%;padding:10px;margin:6px 0;border:1px solid #ccc;border-radius:10px;font-size:16px}
  button{padding:10px 14px;border:0;border-radius:10px;background:#111;color:#fff;font-weight:600}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .ok{color:green;margin:8px 0}.err{color:#b00;margin:8px 0}
</style>
</head>
<body>
<h1>Quick Add</h1>
<p>Paste your <b>API Key</b> once and it saves in this browser.</p>
<input id="key" placeholder="API Key" />
<button onclick="saveKey()">Save Key</button>
<div id="msg"></div>

<fieldset>
  <legend><b>Idea</b></legend>
  <input id="i_title" placeholder="Title*" />
  <textarea id="i_summary" placeholder="Summary"></textarea>
  <button onclick="sendIdea()">Add Idea</button>
</fieldset>

<fieldset>
  <legend><b>Person</b></legend>
  <input id="p_name" placeholder="Full name*" />
  <div class="row">
    <input id="p_phone" placeholder="Phone" />
    <input id="p_email" placeholder="Email" />
  </div>
  <div class="row">
    <input id="p_company" placeholder="Company" />
    <input id="p_role" placeholder="Role/Title" />
  </div>
  <div class="row">
    <input id="p_school" placeholder="School" />
    <input id="p_location" placeholder="Location" />
  </div>
  <button onclick="sendPerson()">Add Person</button>
</fieldset>

<fieldset>
  <legend><b>Tool</b></legend>
  <input id="t_name" placeholder="Name*" />
  <input id="t_url" placeholder="URL (https://...)" />
  <input id="t_category" placeholder="Category (AI/Design/etc.)" />
  <textarea id="t_desc" placeholder="Description"></textarea>
  <button onclick="sendTool()">Add Tool</button>
</fieldset>

<fieldset>
  <legend><b>Research (for an Idea)</b></legend>
  <input id="r_title" placeholder="Idea title* (exact or new)" />
  <div class="row">
    <input id="r_type" placeholder="Type: note | ref | fact" />
    <input id="r_conf" placeholder="Confidence (1–5, for facts)" />
  </div>
  <textarea id="r_note" placeholder="Note text (for type=note)"></textarea>
  <input id="r_src_title" placeholder="Source title (for type=ref)" />
  <input id="r_src_url" placeholder="Source URL (for type=ref/fact)" />
  <textarea id="r_fact" placeholder="Fact statement (for type=fact)"></textarea>
  <button onclick="sendResearch()">Add Research</button>
</fieldset>

<script>
const API = '/api/quick-add';
const msg = (t, ok=true)=>{ const el=document.getElementById('msg'); el.className=ok?'ok':'err'; el.textContent=t; }
const keyBox = document.getElementById('key');
keyBox.value = localStorage.getItem('iv_key') || '';
function saveKey(){ localStorage.setItem('iv_key', keyBox.value.trim()); msg('Key saved ✓', true); }

async function post(url, body){
  const k = (localStorage.getItem('iv_key')||'').trim();
  if(!k) return msg('Add API key first.', false);
  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':k},
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(()=>({}));
  if(r.ok) msg('Saved ✓', true); else msg(data.error || 'Error', false);
}

function sendIdea(){ post(API, { type:'idea', payload:{ title:document.getElementById('i_title').value, summary:document.getElementById('i_summary').value } }); }
function sendPerson(){ post(API, { type:'person', payload:{
  name:document.getElementById('p_name').value,
  phone:document.getElementById('p_phone').value,
  email:document.getElementById('p_email').value,
  company:document.getElementById('p_company').value,
  role:document.getElementById('p_role').value,
  school:document.getElementById('p_school').value,
  location:document.getElementById('p_location').value
}}); }
function sendTool(){ post(API, { type:'tool', payload:{
  name:document.getElementById('t_name').value,
  url:document.getElementById('t_url').value,
  category:document.getElementById('t_category').value,
  description:document.getElementById('t_desc').value
}}); }

function sendResearch(){ 
  post('/api/research-add', {
    rtype: (document.getElementById('r_type').value||'').trim().toLowerCase(),
    idea_title: document.getElementById('r_title').value,
    note: document.getElementById('r_note').value,
    source_title: document.getElementById('r_src_title').value,
    source_url: document.getElementById('r_src_url').value,
    fact: document.getElementById('r_fact').value,
    confidence: document.getElementById('r_conf').value
  });
}
</script>
</body></html>`);
});

// --- List API (GET /api/list?type=idea|person|tool) ---
app.get('/api/list', async (req, res) => {
    try {
      if (!checkKey(req)) return res.status(401).json({ error: 'bad key' });
      const type = (req.query.type || '').toString();
      if (!['idea','person','tool'].includes(type)) {
        return res.status(400).json({ error: 'bad type' });
      }
      const r = await supabase.from(type).select('*').order('created_at', { ascending: false }).limit(200);
      if (r.error) throw r.error;
      res.json(r.data || []);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'server error' });
    }
  });
  
  // --- Idea Research API (GET /api/idea/:id/research) ---
  app.get('/api/idea/:id/research', async (req, res) => {
    try {
      if (!checkKey(req)) return res.status(401).json({ error: 'bad key' });
      const id = req.params.id;
      const [notes, refs, facts] = await Promise.all([
        supabase.from('idea_note').select('*').eq('idea_id', id).order('created_at', { ascending: false }),
        supabase.from('idea_source').select('*').eq('idea_id', id).order('created_at', { ascending: false }),
        supabase.from('idea_fact').select('*').eq('idea_id', id).order('created_at', { ascending: false })
      ]);
      if (notes.error) throw notes.error;
      if (refs.error) throw refs.error;
      if (facts.error) throw facts.error;
      res.json({ notes: notes.data || [], refs: refs.data || [], facts: facts.data || [] });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'server error' });
    }
  });
  // --- Minimal browse UI (GET /app) ---
app.get('/app', (_req, res) => {
    res.set('Content-Type', 'text/html');
    res.send(`<!doctype html>
  <html>
  <head>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Idea Vault — App</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0}
    header{position:sticky;top:0;background:#111;color:#fff;padding:12px 16px}
    .tabs{display:flex;gap:8px;margin-top:8px}
    .tab{padding:8px 12px;border-radius:999px;background:#333;cursor:pointer}
    .tab.active{background:#fff;color:#111;font-weight:700}
    .wrap{max-width:900px;margin:16px auto;padding:0 12px}
    input{width:100%;padding:10px;border:1px solid #ccc;border-radius:10px}
    ul{list-style:none;padding:0;margin:12px 0}
    li{padding:10px;border:1px solid #eee;border-radius:12px;margin:8px 0;cursor:pointer}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eee;margin-left:6px;font-size:12px}
    .panel{display:none}
    .panel.active{display:block}
    .drawer{border:1px dashed #bbb;border-radius:12px;padding:10px;margin-top:8px}
    .muted{color:#666}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  </style>
  </head>
  <body>
  <header>
    <div><b>Idea Vault</b></div>
    <div class="tabs">
      <div class="tab active" data-tab="ideas">Ideas</div>
      <div class="tab" data-tab="people">People</div>
      <div class="tab" data-tab="tools">Tools</div>
    </div>
  </header>
  
  <div class="wrap">
    <input id="key" placeholder="API Key (saved locally)" />
    <div class="muted" id="msg"></div>
  
    <div id="ideas" class="panel active">
      <h3>Ideas</h3>
      <ul id="ideaList"></ul>
      <div id="ideaResearch" class="drawer" style="display:none">
        <div><b id="iTitle"></b></div>
        <div class="row">
          <div>
            <div><b>Notes</b></div>
            <ul id="noteList"></ul>
          </div>
          <div>
            <div><b>References</b></div>
            <ul id="refList"></ul>
            <div><b>Facts</b></div>
            <ul id="factList"></ul>
          </div>
        </div>
      </div>
    </div>
  
    <div id="people" class="panel">
      <h3>People</h3>
      <ul id="peopleList"></ul>
    </div>
  
    <div id="tools" class="panel">
      <h3>Tools</h3>
      <ul id="toolList"></ul>
    </div>
  </div>
  
  <script>
  const msg=(t)=>document.getElementById('msg').textContent=t||'';
  const keyBox=document.getElementById('key');
  keyBox.value=localStorage.getItem('iv_key')||'';
  keyBox.onchange=()=>{ localStorage.setItem('iv_key', keyBox.value.trim()); msg('Key saved ✓'); setTimeout(()=>msg(''),1200); };
  
  function tabTo(id){
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(p=>p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    document.querySelector(\`.tab[data-tab="\${id}"]\`).classList.add('active');
  }
  
  document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>tabTo(t.dataset.tab));
  
  async function getJSON(url){
    const k=(localStorage.getItem('iv_key')||'').trim();
    if(!k){ msg('Enter API key above.'); throw new Error('no key'); }
    const r=await fetch(url,{headers:{'x-api-key':k}});
    if(!r.ok){ const d=await r.json().catch(()=>({})); throw new Error(d.error||'error'); }
    return r.json();
  }
  
  async function loadIdeas(){
    const list=document.getElementById('ideaList'); list.innerHTML='Loading...';
    try{
      const items=await getJSON('/api/list?type=idea');
      list.innerHTML='';
      items.forEach(it=>{
        const li=document.createElement('li');
        li.innerHTML=\`<b>\${it.title||'Untitled'}</b> <span class="pill">\${new Date(it.created_at).toLocaleDateString()}</span><div class="muted">\${it.summary||''}</div>\`;
        li.onclick=()=>openIdea(it);
        list.appendChild(li);
      });
    }catch(e){ list.innerHTML='Error loading.'; }
  }
  async function openIdea(it){
    document.getElementById('iTitle').textContent=it.title||'Untitled';
    document.getElementById('ideaResearch').style.display='block';
    const k=(localStorage.getItem('iv_key')||'').trim();
    const data=await getJSON('/api/idea/'+it.id+'/research');
    const render=(arr,el,fmt)=>{ el.innerHTML=''; if(arr.length===0){el.innerHTML='<li class="muted">none</li>'; return;} arr.forEach(x=>{const li=document.createElement('li'); li.innerHTML=fmt(x); el.appendChild(li);}); };
    render(data.notes, document.getElementById('noteList'), x=>x.content);
    render(data.refs,  document.getElementById('refList'),  x=>\`<a href="\${x.url||'#'}" target="_blank">\${x.title||x.url||'link'}</a>\`);
    render(data.facts, document.getElementById('factList'), x=>\`\${x.statement} <span class="pill">c:\${x.confidence||'-'}</span>\`);
  }
  
  async function loadPeople(){
    const list=document.getElementById('peopleList'); list.innerHTML='Loading...';
    try{
      const items=await getJSON('/api/list?type=person');
      list.innerHTML='';
      items.forEach(p=>{
        const li=document.createElement('li');
        li.innerHTML=\`<b>\${p.name}</b> <span class="muted">\${p.company||''} \${p.role?('· '+p.role):''}</span><div class="muted">\${p.phone||''} \${p.email?('· '+p.email):''}</div>\`;
        list.appendChild(li);
      });
    }catch(e){ list.innerHTML='Error loading.'; }
  }
  
  async function loadTools(){
    const list=document.getElementById('toolList'); list.innerHTML='Loading...';
    try{
      const items=await getJSON('/api/list?type=tool');
      list.innerHTML='';
      items.forEach(t=>{
        const li=document.createElement('li');
        li.innerHTML=\`<b>\${t.name}</b> \${t.url?('<a href="'+t.url+'" target="_blank" class="pill">open</a>'):''}<div class="muted">\${t.category||''} \${t.description?('· '+t.description):''}</div>\`;
        list.appendChild(li);
      });
    }catch(e){ list.innerHTML='Error loading.'; }
  }
  
  // first load
  loadIdeas(); loadPeople(); loadTools();
  </script>
  </body></html>`);
  });
// send home to the app
app.get('/', (_req, res) => res.redirect('/app'));
// Start server (Railway-compatible)
const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log('listening on', port));