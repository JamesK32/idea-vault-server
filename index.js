// index.js
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
// Twilio sends x-www-form-urlencoded, not JSON
app.use(express.urlencoded({ extended: false }));
app.use(express.json()); // <-- add this: lets us read JSON bodies

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);
function checkKey(req) {
    const k = req.headers['x-api-key'] || req.query.key; // header or ?key=...
    return k && process.env.API_KEY && k === process.env.API_KEY;
  }

// health check
app.get('/', (_, res) => res.send('ok'));

// super tiny “type guesser”
function guessType(text = '', hasMedia = false) {
  if (/^\s*idea[:\-]/i.test(text)) return 'idea';
  if (/^\s*(contact|person)[:\-]/i.test(text)) return 'person';
  if (/^\s*tool[:\-]/i.test(text)) return 'tool';
  if (hasMedia) return 'tool'; // screenshots → treat as tool for now
  return 'unknown';
}

// Twilio webhook (we'll point Twilio here later)
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

    // Twilio expects XML, empty is fine
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch (err) {
    console.error(err);
    res.status(500).send('<Response></Response>');
  }
});
// --- Quick Add API (POST /api/quick-add) ---
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
  // --- Quick Add Web Form (GET /add) ---
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
  
  <script>
  const API = '/api/quick-add';
  const msg = (t, ok=true)=>{ const el=document.getElementById('msg'); el.className=ok?'ok':'err'; el.textContent=t; }
  const keyBox = document.getElementById('key');
  keyBox.value = localStorage.getItem('iv_key') || '';
  function saveKey(){ localStorage.setItem('iv_key', keyBox.value.trim()); msg('Key saved ✓', true); }
  
  async function post(type, payload){
    const k = (localStorage.getItem('iv_key')||'').trim();
    if(!k) return msg('Add API key first.', false);
    const r = await fetch(API, {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':k},
      body: JSON.stringify({type, payload})
    });
    const data = await r.json().catch(()=>({}));
    if(r.ok) msg('Saved ✓', true); else msg(data.error || 'Error', false);
  }
  
  function sendIdea(){ post('idea', { title:document.getElementById('i_title').value, summary:document.getElementById('i_summary').value }); }
  function sendPerson(){ post('person', {
    name:document.getElementById('p_name').value,
    phone:document.getElementById('p_phone').value,
    email:document.getElementById('p_email').value,
    company:document.getElementById('p_company').value,
    role:document.getElementById('p_role').value,
    school:document.getElementById('p_school').value,
    location:document.getElementById('p_location').value
  }); }
  function sendTool(){ post('tool', {
    name:document.getElementById('t_name').value,
    url:document.getElementById('t_url').value,
    category:document.getElementById('t_category').value,
    description:document.getElementById('t_desc').value
  }); }
  </script>
  </body></html>`);
  });
const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log('listening on', port));