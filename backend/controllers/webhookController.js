/**
 * Controller del proxy de webhook.
 *
 * El frontend ya no conoce la URL del webhook de n8n (evita exponerla en el
 * JS estático público). En su lugar, POSTea a /webhook/scan (protegido con
 * JWT) y este controller reenvía el payload al webhook real, cuya URL vive
 * solo en el backend (env N8N_WEBHOOK_URL).
 */

const axios = require('axios');
const config = require('../config/environments');

/**
 * POST /webhook/scan
 * Reenvía el payload del escaneo a n8n tal cual llega (sin transformar).
 * Si n8n falla, responde con error para que el frontend use su fallback local.
 */
const forwardScan = async (req, res) => {
  try {
    const n8nUrl = config.n8n.webhookUrl;
    if (!n8nUrl) {
      return res.status(500).json({ error: 'N8N_WEBHOOK_URL not configured' });
    }

    const response = await axios.post(n8nUrl, req.body, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });

    res.status(response.status).json(response.data || { success: true });
  } catch (e) {
    console.error('Webhook forward error:', e.message);
    res.status(e.response?.status || 502).json({ error: 'Failed to forward to webhook' });
  }
};

module.exports = { forwardScan };
