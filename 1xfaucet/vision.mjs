import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'));
const { host, api_key, model } = config.ollama;

export async function askVision(prompt, imagePaths) {
  const images = imagePaths.map(p => readFileSync(p).toString('base64'));

  const body = {
    model,
    messages: [{
      role: 'user',
      content: prompt,
      images
    }],
    stream: false
  };

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.message?.content || '';
  return content;
}

export function parseJSON(text) {
  // Extract JSON from response (may be wrapped in markdown code blocks)
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch {}
  }
  // Try parsing the whole text
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}
