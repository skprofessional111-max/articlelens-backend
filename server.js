const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── HTML helpers ──────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1];
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) return h1[1].trim();
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) return title[1].trim();
  return '';
}

// ── Groq call ─────────────────────────────────────────────────────────────────
async function callGroq(messages, maxTokens) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + GROQ_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens || 1000,
      temperature: 0.3,
      messages,
    }),
  });
  const data = await response.json();
  if (!data.choices) {
    console.error('Groq error:', JSON.stringify(data));
    throw new Error(data.error ? data.error.message : 'Groq API error');
  }
  return data.choices[0].message.content.trim();
}

// ── Summarize ─────────────────────────────────────────────────────────────────
async function summarize(articleText, title) {
  const text = await callGroq([
    {
      role: 'system',
      content: 'You are an expert article analyst. You MUST respond with ONLY a valid JSON object and nothing else. No markdown, no backticks, no explanation before or after. Just the raw JSON object.',
    },
    {
      role: 'user',
      content: 'Analyze this article and return ONLY this JSON structure with no other text:\n{"title":"string","summary":"string with 4-6 sentences giving deep analytical summary with context and implications","takeaways":["emoji + takeaway 1","emoji + takeaway 2","emoji + takeaway 3","emoji + takeaway 4","emoji + takeaway 5"]}\n\nTitle: ' + title + '\n\nContent: ' + articleText.slice(0, 5000),
    },
  ], 1000);

  // Extract JSON robustly
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return valid JSON');
  return JSON.parse(match[0]);
}

// ── Scrape ────────────────────────────────────────────────────────────────────
async function scrapeArticle(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
  });
  const html = await response.text();
  return { title: extractTitle(html), text: stripHtml(html) };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/summarize-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const { title, text } = await scrapeArticle(url);
    if (text.length < 100) return res.status(422).json({ error: 'Could not extract enough text from this page.' });
    const result = await summarize(text, title);
    res.json({ ...result, url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/summarize-text', async (req, res) => {
  const { text, title } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });
  try {
    const result = await summarize(text, title || '');
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/summarize-rss-item', async (req, res) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const { text } = await scrapeArticle(url);
    const result = await summarize(text, title || '');
    res.json({ ...result, url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/fetch-rss', async (req, res) => {
  const { feedUrl } = req.body;
  if (!feedUrl) return res.status(400).json({ error: 'feedUrl is required' });
  try {
    const response = await fetch(feedUrl);
    const xml = await response.text();
    const items = [];
    const matches = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi);
    for (const match of matches) {
      const block = match[1];
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim() || '';
      const link = (block.match(/<link[^>]*>(https?[^<]+)<\/link>/i) || [])[1]?.trim() || '';
      const desc = stripHtml((block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '').slice(0, 300);
      if (title && link) items.push({ title, link, description: desc });
      if (items.length >= 20) break;
    }
    res.json({ articles: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  const { question, articleText, articleTitle, history } = req.body;
  if (!question || !articleText) return res.status(400).json({ error: 'question and articleText required' });
  try {
    const messages = [
      {
        role: 'system',
        content: 'You are an expert analyst helping a user deeply understand an article. Be thorough, analytical, and insightful. Provide context, implications, and nuance in your answers.\n\nArticle Title: ' + (articleTitle || '') + '\nArticle Content: ' + articleText.slice(0, 5000),
      },
      ...(history || []),
      { role: 'user', content: question },
    ];
    const answer = await callGroq(messages, 800);
    res.json({ answer });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('ArticleLens backend running on port ' + PORT);
  // Keep alive ping every 4 minutes to prevent Railway from sleeping
  setInterval(() => {
    fetch('http://localhost:' + PORT + '/health')
      .then(() => console.log('Keep-alive ping sent'))
      .catch(() => {});
  }, 4 * 60 * 1000);
});
