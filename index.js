// index.js
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
// Twilio sends x-www-form-urlencoded, not JSON
app.use(express.urlencoded({ extended: false }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

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

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log('listening on', port));