/**
 * Buzón IA — generador de borradores de respuesta (Fase 2A)
 *
 * Dado un correo entrante + su clasificación + FAQ del tenant, Claude redacta
 * una respuesta en texto plano, en el idioma del cliente, con tono muy amable.
 * La firma se añade siempre al final tal cual se recibe en opts.signature.
 */

const AnthropicLib = require('@anthropic-ai/sdk');
const Anthropic = AnthropicLib.Anthropic || AnthropicLib.default || AnthropicLib;

// Usamos Haiku por coste (son muchos correos). Si el tenant quisiera más
// calidad se puede cambiar a Sonnet aquí.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_BODY_CHARS = 6000;

function _trim(text, max) {
  if (!text) return '';
  const t = String(text).replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '\n\n[...truncado...]';
}

function _buildSystemPrompt(opts) {
  const tenantName = opts.tenantName || 'el establecimiento';
  const signature = opts.signature || '';
  const faq = opts.faqMarkdown || '';
  const category = opts.category || 'otros';
  const lang = opts.language || 'es';

  return `Eres el asistente de respuesta de "${tenantName}". Tu tarea es redactar un BORRADOR de respuesta al correo entrante para que el gerente solo tenga que revisarlo, editarlo si hace falta y enviarlo.

## Tono
Muy amable, cercano, cordial. Trata siempre de USTED (en español). Evita jerga, sé concreto, breve pero cálido. Nunca seas frío ni robótico. Usa frases como "Muchas gracias por escribirnos", "Estaremos encantados de atenderle", "Quedamos a su disposición".

## Idioma
Responde SIEMPRE en el idioma del cliente. Idioma detectado: ${lang}. Si la detección falla, responde en el idioma del cuerpo del correo original. Usa el "usted" en español, "vous" en francés, "Sie" en alemán, "u" en neerlandés. En inglés, tono educado y profesional.

## Categoría del correo
"${category}". Adáptate al tipo:
- reserva: confirma que se revisará la disponibilidad. Si en la FAQ hay precios aplicables a las fechas/vehículo que menciona, INCLÚYELOS explícitamente. Si faltan datos para cerrar la reserva (fechas exactas, nº personas, tipo de vehículo, metros), pídelos amablemente. NUNCA confirmes una reserva por tu cuenta.
- factura: confirma que se emitirá o duplicará la factura y pídele los datos fiscales si no los da (razón social, CIF, dirección). Dile que en breve recibirá la factura por email.
- soporte: responde a la duda usando la FAQ como fuente de verdad. Si la FAQ no cubre el tema, dilo con naturalidad: "le consultamos y le respondemos en breve".
- reclamacion: muestra empatía primero ("lamentamos profundamente..."), agradece que nos lo haya comunicado, indica que el gerente lo revisará personalmente y contactará con él lo antes posible. Ningún compromiso concreto (ni reembolso, ni compensación).
- spam: NO generes borrador. Devuelve EXACTAMENTE la cadena: "__NO_REPLY__"
- otros: respuesta cortés genérica. Si no está claro qué pide, pide aclaración educadamente.

## Estructura
1. Saludo con el nombre del cliente si lo conoces (ej. "Estimado/a Juan,"). Si no, "Buenos días," o el equivalente en su idioma.
2. Una frase de agradecimiento por el contacto.
3. Cuerpo de la respuesta: 2-4 frases cortas. No te inventes datos, precios o disponibilidad que no estén en la FAQ.
4. Cierre: "Quedamos a su disposición para cualquier consulta adicional." (o equivalente en su idioma).
5. Firma EXACTA (se añade automáticamente, no la incluyas tú).

## Reglas absolutas
- NUNCA inventes datos: precios, disponibilidad, horarios, nombres de empleados. Si no lo sabes, no lo digas.
- NUNCA prometas cosas que no puedas cumplir (reembolsos, descuentos, confirmaciones).
- NUNCA uses markdown (nada de **negritas** ni listas con guiones). Texto plano.
- NUNCA incluyas la firma ni "Un saludo" al final — el sistema la añade automáticamente.
- SI el cliente parece enfadado, sube la empatía y baja el tono comercial.
- Máximo 120 palabras en el cuerpo (sin contar saludo ni cierre).

## FAQ del cliente (fuente de verdad sobre el establecimiento)
${faq || '(sin FAQ cargado)'}

## Salida
${lang === 'es'
  ? 'Devuelve SOLO el texto del borrador, en texto plano, sin comillas, sin explicación. Ni siquiera pongas "Borrador:" al principio. Directamente el texto listo para enviar (sin la firma — esa va aparte).'
  : 'Devuelve un JSON VÁLIDO con dos claves:\n  - "draft": el borrador en el idioma del cliente (' + lang + '), en texto plano, sin firma.\n  - "preview_es": UNA TRADUCCIÓN FIEL al castellano del mismo borrador (para que recepción revise que lo que se va a enviar es correcto). Mantén la traducción natural y cortés, trato de usted.\nNo añadas comentarios, ni markdown, ni backticks. Solo el JSON. Ejemplo:\n{"draft":"Dear Sir, thank you...","preview_es":"Estimado Señor, muchas gracias..."}'}`;
}

function _buildUserMsg(opts) {
  const parts = [];
  parts.push('Correo a responder:');
  parts.push('');
  parts.push('DE: ' + (opts.fromName ? opts.fromName + ' <' + (opts.fromEmail || '') + '>' : (opts.fromEmail || 'desconocido')));
  parts.push('ASUNTO: ' + (opts.subject || '(sin asunto)'));
  if (opts.extracted && Object.keys(opts.extracted).length) {
    parts.push('DATOS EXTRAÍDOS POR IA: ' + JSON.stringify(opts.extracted));
  }
  parts.push('');
  parts.push('CUERPO:');
  parts.push(_trim(opts.bodyText || '', MAX_BODY_CHARS));
  return parts.join('\n');
}

/**
 * Genera borrador de respuesta.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.tenantName
 * @param {string} opts.signature - firma completa (se anexa al final del borrador)
 * @param {string} opts.faqMarkdown
 * @param {string} opts.category
 * @param {string} opts.language
 * @param {string} opts.subject
 * @param {string} opts.bodyText
 * @param {string} opts.fromEmail
 * @param {string} opts.fromName
 * @param {object} opts.extracted
 * @returns {Promise<{draft:string, skipped:boolean}>}
 */
async function generateDraft(opts) {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const lang = opts.language || 'es';

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: _buildSystemPrompt(opts),
    messages: [{ role: 'user', content: _buildUserMsg(opts) }]
  });

  const raw = (resp.content && resp.content[0] && resp.content[0].text) || '';
  const body = raw.trim();

  if (body === '__NO_REPLY__' || /^__NO_REPLY__$/m.test(body)) {
    return { draft: '', draftPreviewEs: '', skipped: true };
  }

  const sig = (opts.signature || '').trim();

  // Si idioma = español → respuesta en texto plano, preview = draft
  if (lang === 'es') {
    let cleaned = body
      .replace(/^borrador:\s*/i, '')
      .replace(/^"([\s\S]*)"$/m, '$1')
      .trim();
    const full = sig ? (cleaned + '\n\n' + sig) : cleaned;
    return { draft: full, draftPreviewEs: full, skipped: false };
  }

  // Idioma no-español → esperamos JSON {draft, preview_es}
  let draftTxt = '';
  let previewEs = '';
  try {
    // Limpiar posibles backticks o prefijos
    const jsonTxt = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(jsonTxt);
    draftTxt = String(parsed.draft || '').trim();
    previewEs = String(parsed.preview_es || parsed.previewEs || '').trim();
  } catch (e) {
    // Fallback: si no parsea, usamos el body completo como draft y dejamos preview vacío
    console.warn('[draft] JSON parse failed, fallback raw body. err=', e.message);
    draftTxt = body;
    previewEs = '';
  }

  if (!draftTxt) draftTxt = body;

  const fullDraft = sig ? (draftTxt + '\n\n' + sig) : draftTxt;
  const fullPreview = previewEs
    ? (sig ? (previewEs + '\n\n' + sig) : previewEs)
    : '';

  return { draft: fullDraft, draftPreviewEs: fullPreview, skipped: false };
}

module.exports = { generateDraft };
