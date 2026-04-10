const express = require('express');
const router = express.Router();
const netsuiteController = require('../controllers/netsuiteController');
const { verifyToken } = require('../middleware/auth');

// Test de conexión Token-based Auth (sin protección para debug)
router.get('/test', async (req, res) => {
  try {
    const netsuiteClient = require('../config/netsuiteAuth');
    const config = require('../config/environments');

    console.log('\n🔍 Testing NetSuite Token-based Auth...');
    const response = await netsuiteClient.get('/record/salesorder/1', {
      validateStatus: () => true
    });

    res.status(200).json({
      test: 'TOKEN_BASED_AUTH_TEST',
      status: response.status,
      statusText: response.statusText,
      url: `${config.netsuite.baseUrl()}/record/salesorder/1`,
      response: {
        status: response.status,
        error: response.data?.error || response.statusText,
        details: response.data
      }
    });
  } catch (error) {
    res.status(500).json({
      test: 'ERROR',
      error: error.message
    });
  }
});

// Diagnóstico de conexión (sin protección para debug)
router.get('/diagnostic', netsuiteController.diagnosticTest);

// Obtener IFs disponibles (protegido)
router.get('/ifs', verifyToken, netsuiteController.getIFs);

// Enviar datos y firmas (protegido)
router.post('/submit', verifyToken, netsuiteController.submitData);

module.exports = router;
