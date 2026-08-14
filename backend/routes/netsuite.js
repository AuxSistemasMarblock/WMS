const express = require('express');
const router = express.Router();
const netsuiteController = require('../controllers/netsuiteController');
const { verifyToken, devOnly } = require('../middleware/auth');

// Diagnóstico de conexión (solo dev)
router.get('/diagnostic', devOnly, netsuiteController.diagnosticTest);

// Obtener IFs disponibles (protegido)
router.get('/ifs', verifyToken, netsuiteController.getIFs);

// Enviar datos y firmas (protegido)
router.post('/submit', verifyToken, netsuiteController.submitData);

module.exports = router;
