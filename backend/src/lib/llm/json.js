/** Shared helpers for turning free-form model text into a JSON object. */
export const stripThink = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

export function extractJson(text) {
  const clean = stripThink(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : clean;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}
