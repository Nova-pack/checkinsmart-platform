/**
 * Buzón IA — clasificador y extractor de datos
 *
 * Dado un correo (asunto + cuerpo en texto plano), Claude Haiku devuelve:
 *   - category: reserva | factura | soporte | reclamacion | spam | otros
 *   - confidence: 0..1
 *   - language: es | en | fr | de | nl | other
 *   - priority: normal | alta | critica
 *   - extracted: campos estructurados (fechas, nombre, teléfono, etc.)
 *
 * El FAQ del tenant se inyecta como base de conocimiento para mejorar
 * la clasificación (ej. si preguntan por "precio de lavadora" → soporte).
 */

const AnthropicLib = require('@anthropic-ai/sdk');
// La 0.90 exporta la clase como top-level function y como .default
const Anthropic = AnthropicLib.Anthropic || AnthropicLib.default || AnthropicLib;

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_BODY_CHARS = 8000; // truncar correos muy largos para controlar coste

function _trimBody(text) {
  if (!text) return '';
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (clean.length <= MAX_BODY_CHARS) return clean;
  return clean.slice(0, MAX_BODY_CHARS) + '\n\n[...correo truncado para clasificación...]';
}

function _buildSystemPrompt(faqMarkdown, tenantName) {
  return `Eres el asistente del buzón de correos de "${tenantName || 'un camping/área de autocaravanas'}".

Tu tarea es clasificar el correo entrante y extraer los datos relevantes en JSON.

## Categorías
- "reserva": el cliente consulta disponibilidad, pregunta por tarifas de fechas concretas, pide reservar, modifica o confirma reserva.
- "factura": petición de factura, duplicado, rectificación, datos fiscales.
- "soporte": preguntas sobre el área (WiFi, servicios, normas, direcciones, horarios), dudas no relacionadas con una reserva activa.
- "reclamacion": queja, reclamación formal, descontento, petición de reembolso, amenaza legal.
- "spam": marketing no solicitado, phishing, listas automáticas, newsletters.
- "otros": nada de lo anterior encaja claramente.

## Prioridades
- "critica": reclamación, amenaza legal, cliente enfadado, emergencia.
- "alta": reserva inminente (fechas < 7 días), cancelación, problema operativo.
- "normal": el resto.

## Idioma
Detecta el idioma del cuerpo: es, en, fr, de, nl, other.

## Extracción de datos (para categoría "reserva" principalmente)
Extrae SOLO lo que aparezca explícito. No inventes.
- dateIn, dateOut: formato ISO "YYYY-MM-DD". Si ponen "del 10 al 15 de agosto 2026" → dateIn="2026-08-10", dateOut="2026-08-15".
- guests: número total de personas.
- adults, children: si lo distinguen.
- vehicleType: "autocaravana" | "camper" | "caravana" | "furgoneta" | "tienda" | null.
- vehicleLengthM: metros (número) si lo mencionan.
- withPets: true/false/null si mencionan mascotas.
- phone: si lo dan.
- nameGuess: nombre del remitente si se puede deducir.

## Salida
Devuelve EXCLUSIVAMENTE un JSON válido con esta forma (sin markdown, sin explicación):

{
  "category": "reserva",
  "confidence": 0.92,
  "language": "es",
  "priority": "normal",
  "summary": "Cliente pide disponibilidad 10-15 agosto para autocaravana de 7m, 2 adultos",
  "extracted": {
    "dateIn": "2026-08-10",
    "dateOut": "2026-08-15",
    "guests": 2,
    "adults": 2,
    "children": 0,
    "vehicleType": "autocaravana",
    "vehicleLengthM": 7,
    "withPets": false,
    "phone": null,
    "nameGuess": "Juan Pérez"
  },
  "tags": ["temporada_alta", "vehiculo_largo"]
}

Si un campo no aparece, pon null.

## Base de conocimiento (FAQ del cliente)
Úsala para entender el contexto. No respondas al correo, solo clasifica.

${faqMarkdown || '(sin FAQ cargado)'}`;
}

/**
 * Clasifica un correo.
 * @param {object} opts
 * @param {string} opts.apiKey - Anthropic API key
 * @param {string} opts.faqMarkdown - FAQ del tenant como texto markdown
 * @param {string} opts.tenantName - nombre legible del tenant
 * @param {string} opts.subject
 * @param {string} opts.bodyText
 * @param {string} opts.fromEmail
 * @returns {Promise<object>} clasificación y extracción
 */
async function classifyEmail(opts) {
  const client = new Anthropic({ apiKey: opts.apiKey });

  const userMsg = [
    'Clasifica el siguiente correo:',
    '',
    `DE: ${opts.fromEmail || 'desconocido'}`,
    `ASUNTO: ${opts.subject || '(sin asunto)'}`,
    '',
    'CUERPO:',
    _trimBody(opts.bodyText)
  ].join('\n');

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: _buildSystemPrompt(opts.faqMarkdown, opts.tenantName),
    messages: [{ role: 'user', content: userMsg }]
  });

  const text = (resp.content && resp.content[0] && resp.content[0].text) || '';
  // Extraer el primer bloque JSON
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      category: 'unclassified',
      confidence: 0,
      language: 'other',
      priority: 'normal',
      summary: '(IA no devolvió JSON)',
      extracted: {},
      tags: [],
      _raw: text
    };
  }
  try {
    const parsed = JSON.parse(match[0]);
    // Validación mínima
    parsed.category = parsed.category || 'otros';
    parsed.confidence = Number(parsed.confidence) || 0;
    parsed.language = parsed.language || 'other';
    parsed.priority = parsed.priority || 'normal';
    parsed.extracted = parsed.extracted || {};
    parsed.tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    return parsed;
  } catch (e) {
    return {
      category: 'unclassified',
      confidence: 0,
      language: 'other',
      priority: 'normal',
      summary: '(JSON parse error)',
      extracted: {},
      tags: [],
      _raw: text,
      _error: e.message
    };
  }
}

module.exports = { classifyEmail };
