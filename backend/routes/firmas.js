/**
 * Rutas para manejar firmas
 */

const express = require('express');
const router = express.Router();
const firmasController = require('../controllers/firmasController');
const { verifyToken } = require('../middleware/auth');

/**
 * POST /firmas/upload
 * Subir una o múltiples firmas
 */
router.post('/upload', verifyToken, firmasController.uploadSignatures);

/**
 * POST /firmas/upload/single
 * Subir un archivo individual
 */
router.post('/upload/single', verifyToken, firmasController.uploadSingleFile);

module.exports = router;
