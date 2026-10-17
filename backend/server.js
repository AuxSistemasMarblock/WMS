const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Rutas
app.use('/auth', require('./routes/auth'));
app.use('/auth/netsuite', require('./routes/oauth'));
app.use('/netsuite', require('./routes/netsuite'));
app.use('/firmas', require('./routes/firmas'));
app.use('/validate', require('./routes/validation'));
app.use('/webhook', require('./routes/webhook'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/etiquetas', require('./routes/etiquetas'));
app.use('/api/casos', require('./routes/casos'));

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Something went wrong',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

const server = app.listen(PORT, () => {
  const mem = process.memoryUsage();
  console.log(`🚀 WMS Backend running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV}`);
  console.log(`🕐 Started at: ${new Date().toISOString()} | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`);
});

// Apagado ordenado: cuando Docker/K8s detiene el contenedor envía SIGTERM/SIGINT.
// Registrar la señal permite distinguir en los logs una parada externa de un crash.
let shuttingDown = false;
const gracefulShutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} recibido a las ${new Date().toISOString()} — apagado ordenado (parada externa del contenedor, no es un crash)`);
  server.close(() => {
    console.log('👋 Servidor HTTP cerrado correctamente');
    process.exit(0);
  });
  // Forzar salida si hay conexiones colgadas (p. ej. requests largos a NetSuite)
  setTimeout(() => {
    console.warn('⏱️ Graceful shutdown: timeout de 25s alcanzado, forzando salida');
    process.exit(1);
  }, 25000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Crash con log explícito (mismo comportamiento por defecto de Node, pero visible)
process.on('uncaughtException', (err) => {
  console.error(`💥 Uncaught Exception a las ${new Date().toISOString()}:`, err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`💥 Unhandled Rejection a las ${new Date().toISOString()}:`, reason);
  process.exit(1);
});
