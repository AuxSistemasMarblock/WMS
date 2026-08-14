/**
 * Rutas del proxy de webhook (n8n).
 * El frontend envía el escaneo aquí; el backend lo reenvía a n8n.
 */

const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const { verifyToken } = require('../middleware/auth');

// POST /webhook/scan (requiere JWT)
router.post('/scan', verifyToken, webhookController.forwardScan);

module.exports = router;
