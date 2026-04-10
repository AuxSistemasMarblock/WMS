const express = require('express');
const router = express.Router();
const oauthController = require('../controllers/oauthController');

// Test de conexión OAuth 2.0 (sin protección para debug)
router.get('/oauth/test', oauthController.testOAuth2Connection);

// Iniciar flujo OAuth 2.0
// GET /auth/netsuite/oauth/initiate → redirige a NetSuite
router.get('/oauth/initiate', oauthController.initiateOAuth);

// Callback de OAuth 2.0
// NetSuite redirige aquí con el authorization code
// GET /auth/netsuite/oauth/callback?code=...&state=...
router.get('/oauth/callback', oauthController.oauthCallback);

module.exports = router;
