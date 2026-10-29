/**
 * Rutas del respaldo de escaneos.
 * El frontend envía el escaneo aquí; el backend lo agrega a Google Sheets.
 */

const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const { verifyToken } = require('../middleware/auth');

// POST /webhook/scan (requiere JWT)
router.post('/scan', verifyToken, webhookController.forwardScan);

module.exports = router;
