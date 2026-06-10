const express = require('express');
const router = express.Router();
const netsuiteController = require('../controllers/netsuiteController');
const { verifyToken } = require('../middleware/auth');

// Diagnóstico de conexión (sin protección para debug)
router.get('/diagnostic', netsuiteController.diagnosticTest);

// Obtener IFs disponibles (protegido)
router.get('/ifs', verifyToken, netsuiteController.getIFs);

// Enviar datos y firmas (protegido)
router.post('/submit', verifyToken, netsuiteController.submitData);

module.exports = router;
