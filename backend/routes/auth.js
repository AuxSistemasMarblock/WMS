const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken } = require('../middleware/auth');

// Login
router.post('/login', authController.login);

// Get current user (protegido)
router.get('/user', verifyToken, authController.getUser);

// Logout
router.post('/logout', authController.logout);

module.exports = router;
