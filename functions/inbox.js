/**
 * inbox.js — Módulo de buzón IA (stub temporal)
 * Las funciones reales se implementarán en una sesión posterior.
 */
const { onRequest } = require('firebase-functions/v2/https');

const _stub = (name) => onRequest({ region: 'europe-west1', cors: true }, (req, res) => {
  res.status(501).json({ error: `${name} not implemented yet` });
});

const _scheduledStub = (name) => {
  // onSchedule stub — devuelve null para evitar deploy de scheduled functions no configuradas
  return null;
};

exports.pollInboxScheduled    = _scheduledStub('pollInboxScheduled');
exports.pollInboxManual       = _stub('pollInboxManual');
exports.generateInboxDraft    = _stub('generateInboxDraft');
exports.sendInboxReply        = _stub('sendInboxReply');
exports.translateInboxMessage = _stub('translateInboxMessage');
