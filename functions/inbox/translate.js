/**
 * Buzón IA — Traductor de correos entrantes al castellano.
 *
 * Claude Haiku traduce asunto + cuerpo al castellano. El resultado se cachea
 * en el propio documento del mensaje (campo translationEs) para que no se
 * vuelva a llamar a la API si recepción vuelve a pulsar el botón.
 */

const AnthropicLib = require('@anthropic-ai/sdk');
const Anthropic = AnthropicLib.Anthropic || AnthropicLib.default || AnthropicLib;

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_BODY_CHARS = 6000;

function _trim(text, max) {
  if (!text) return '';
  const t = String(text).replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n\n[...truncado...]';
}

/**
 * Traduce asunto + cuerpo al castellano.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.subject
 * @param {string} opts.bodyText
 * @param {string} opts.sourceLang (ej. 'fr', 'de', 'en', 'nl'...)
 * @returns {Promise<{subject:string, bodyText:string, sourceLang:string}>}
 */
async function translateToSpanish(opts) {
  const subject = String(opts.subject || '').trim();
  const bodyText = _trim(opts.bodyText || '', MAX_BODY_CHARS);

  if (!subject && !bodyText) {
    return { subject: '', bodyText: '', sourceLang: opts.sourceLang || 'other' };
  }

  const client = new Anthropic({ apiKey: opts.apiKey });

  const systemPrompt = `Eres un traductor profesional. Traduces correos electrónicos al castellano (España) manteniendo el tono del original. Sigue estas reglas:
- Si el texto ya está en castellano, devuélvelo tal cual.
- Preserva formato (saltos de línea, listas).
- No añadas explicaciones, comentarios ni notas del traductor.
- Traduce nombres propios solo si tienen equivalente español común (ej. no traduzcas "John" pero sí "London" → "Londres").
- Mantén fechas, horas, números y datos como en el original.
- Trato de usted en la traducción.

Devuelve EXCLUSIVAMENTE un JSON válido con dos claves:
{"subject":"...", "body":"..."}
Sin markdown, sin backticks, sin texto adicional.`;

  const userMsg = 'Traduce al castellano:\n\nASUNTO:\n' + (subject || '(sin asunto)') + '\n\nCUERPO:\n' + (bodyText || '(vacío)');

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }]
  });

  const raw = (resp.content && resp.content[0] && resp.content[0].text) || '';
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let outSubject = subject;
  let outBody = bodyText;
  try {
    const parsed = JSON.parse(cleaned);
    outSubject = String(parsed.subject || subject).trim();
    outBody = String(parsed.body || bodyText).trim();
  } catch (e) {
    console.warn('[translate] JSON parse failed, fallback to raw. err=', e.message);
    // Si no parseó, devolvemos el texto crudo como cuerpo
    outBody = cleaned || bodyText;
  }

  return {
    subject: outSubject,
    bodyText: outBody,
    sourceLang: opts.sourceLang || 'other'
  };
}

module.exports = { translateToSpanish };
