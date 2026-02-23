const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_API_KEY = process.env.GROQ_API_KEY;

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
    .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle) return ogTitle[1];
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1) return h1[1].trim();
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) return title[1].trim();
  return '';
}

async function summarizeWithGroq(articleText, title) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1000,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `You are an expert article analyst. Respond ONLY with a JSON object (no markdown, no backticks, no extra text):
{"title":"Article title","summary":"3-5 sentence summary capturing the core message","takeaways":["emoji + takeaway","emoji + takeaway","emoji + takeaway","emoji + takeaway"]}`
        },
        {
          role: 'user',
          content: `Title: ${title}\n\nContent: ${articleText.slice(0, 6000)}`
        }
      ],
    }),
  });

  const data = await response.json();
  if (!data.choices) {
    console.error('Groq API error:', JSON.stringify(data));
    throw new Error(data.error?.message || 'Groq API error');
  }
  const text = data.choices[0].message.content.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function scrapeArticle(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' },
  });
  const html = await response.text();
  return { title: extractTitle(html), text: stripHtml(html) };
}

app.post('/summarize-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const { title, text } = await scrapeArticle(url);
    const result = await summarizeWithGroq(text, title);
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
    const result = await summarizeWithGroq(text, title || '');
    res.json(result);
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
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)||[])[1]?.trim()||'';
      const link = (block.match(/<link[^>]*>(https?[^<]+)<\/link>/i)||[])[1]?.trim()||'';
      const desc = stripHtml((block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)||[])[1]||'').slice(0,300);
      if (title && link) items.push({ title, link, description: desc });
      if (items.length >= 20) break;
    }
    res.json({ articles: items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/summarize-rss-item', async (req, res) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const { text } = await scrapeArticle(url);
    const result = await summarizeWithGroq(text, title || '');
    res.json({ ...result, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/chat', async (req, res) => {
  const { question, articleText, articleTitle, history } = req.body;
  if (!question || !articleText) return res.status(400).json({ error: 'question and articleText are required' });
  try {
    const messages = [
      {
        role: 'system',
        content: `You are an expert analyst helping a user understand an article deeply. Answer questions thoroughly and insightfully. Provide context, implications, and nuance. Be analytical and helpful.

Article Title: ${articleTitle || 'Unknown'}
Article Content: ${articleText}`
      },
      ...(history || []),
      { role: 'user', content: question }
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 800,
        temperature: 0.5,
        messages,
      }),
    });
    const data = await response.json();
    if (!data.choices) throw new Error(data.error?.message || 'Groq API error');
    res.json({ answer: data.choices[0].message.content.trim() });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`ArticleLens backend running on port ${PORT}`));
