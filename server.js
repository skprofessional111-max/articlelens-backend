const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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

async function summarizeWithGemini(articleText, title) {
  const prompt = `You are an expert article analyst. Analyze this article and respond ONLY with a JSON object (no markdown, no backticks, no extra text):
{"title":"Article title","summary":"3-5 sentence summary capturing the core message","takeaways":["emoji + takeaway","emoji + takeaway","emoji + takeaway","emoji + takeaway"]}

Title: ${title}
Content: ${articleText.slice(0, 6000)}`;

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
    }),
  });

  const data = await response.json();
  if (!data.candidates) {
    console.error('Gemini API error:', JSON.stringify(data));
    throw new Error(data.error?.message || 'Gemini API error');
  }
  const text = data.candidates[0].content.parts[0].text.trim();
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
    const result = await summarizeWithGemini(text, title);
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
    const result = await summarizeWithGemini(text, title || '');
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
    const result = await summarizeWithGemini(text, title || '');
    res.json({ ...result, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`ArticleLens backend running on port ${PORT}`));
