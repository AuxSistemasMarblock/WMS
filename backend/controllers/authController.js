const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const supabase = require('../config/supabase');
const auditService = require('../services/auditService');
const mfaService = require('../services/mfaService');

/**
 * Login: Autentica usuario con email y contraseña
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Buscar usuario en Supabase (join con roles para obtener la clave)
    const { data: usuario, error: queryError } = await supabase
      .from('usuarios')
      .select('*, roles(clave, nombre)')
      .eq('email', email.toLowerCase())
      .single();

    if (queryError || !usuario) {
      // WMS 2.0 · A1: bitácora de logins fallidos (IP + user-agent)
      auditService.registrarDesdeReq(req, {
        usuarioId: null,
        emailIntento: email.toLowerCase(),
        tipoEvento: auditService.TIPOS.LOGIN_FALLIDO,
        accion: 'login',
        detalle: { motivo: 'usuario_no_encontrado' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Validar contraseña contra hash bcrypt
    const passwordMatch = await bcryptjs.compare(password, usuario.password_hash);
    if (!passwordMatch) {
      auditService.registrarDesdeReq(req, {
        usuarioId: usuario.id,
        emailIntento: email.toLowerCase(),
        tipoEvento: auditService.TIPOS.LOGIN_FALLIDO,
        accion: 'login',
        detalle: { motivo: 'password_incorrecto' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!usuario.activo) {
      auditService.registrarDesdeReq(req, {
        usuarioId: usuario.id,
        emailIntento: email.toLowerCase(),
        tipoEvento: auditService.TIPOS.LOGIN_FALLIDO,
        accion: 'login',
        detalle: { motivo: 'usuario_inactivo' }
      });
      return res.status(403).json({ error: 'User is inactive' });
    }

    // Obtener ubicacion del usuario
    const { data: ubicacion } = await supabase
      .from('ubicaciones')
      .select('id, nombre')
      .eq('id', usuario.ubicacion_id)
      .single();

    // WMS 2.0 · R1: el rol se toma SOLO de roles.clave (sin fallback `cargo`
    // legacy). Un usuario sin rol asignado no debe operar el sistema.
    const rolClave = usuario.roles?.clave || null;
    if (!rolClave) {
      auditService.registrarDesdeReq(req, {
        usuarioId: usuario.id,
        emailIntento: email.toLowerCase(),
        tipoEvento: auditService.TIPOS.LOGIN_FALLIDO,
        accion: 'login',
        detalle: { motivo: 'sin_rol_asignado' }
      });
      return res.status(403).json({ error: 'User has no assigned role' });
    }

    // WMS 2.0 · S2: el 2FA es OBLIGATORIO para admin. El login queda pendiente:
    //  - con totp_activo  -> verificar código TOTP (/auth/login/2fa)
    //  - sin totp_activo  -> enrolamiento forzado (/auth/2fa/setup + verify-setup)
    if (rolClave === 'admin') {
      const paso = usuario.totp_activo ? '2fa_login' : '2fa_enrolamiento';
      const respuesta = {
        tempToken: mfaService.generarTempToken(usuario.id, paso),
        user: { id: usuario.id, email: usuario.email, nombre: usuario.nombre_completo, rol: rolClave }
      };
      if (usuario.totp_activo) respuesta.requiere2FA = true;
      else respuesta.requiereEnrolamiento2FA = true;
      return res.json(respuesta);
    }

    await emitirSesion(req, res, usuario, rolClave, ubicacion);
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
};

/**
 * Emite la sesión definitiva: bitácora de login exitoso, ultimo_login y JWT.
 * Usado por login (roles sin 2FA), login2FA y verifySetup2FA (admin).
 */
async function emitirSesion(req, res, usuario, rolClave, ubicacion = null) {
  if (!ubicacion && usuario.ubicacion_id) {
    const { data: ub } = await supabase
      .from('ubicaciones')
      .select('id, nombre')
      .eq('id', usuario.ubicacion_id)
      .single();
    ubicacion = ub || null;
  }

  // WMS 2.0 · A1: bitácora de login exitoso + ultimo_login (fire-and-forget)
  const ahora = new Date().toISOString();
  supabase.from('usuarios').update({ ultimo_login: ahora }).eq('id', usuario.id)
    .then(({ error: upErr }) => {
      if (upErr) console.error('[audit] error actualizando ultimo_login:', upErr.message);
    });
  auditService.registrarDesdeReq(req, {
    usuarioId: usuario.id,
    tipoEvento: auditService.TIPOS.LOGIN_EXITOSO,
    accion: 'login',
    entidad: 'usuarios',
    entidadId: usuario.id,
    detalle: { rol: rolClave }
  });

  const token = jwt.sign(
    {
      id: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre_completo,
      cargo: usuario.cargo,
      rol: rolClave,
      ubicacion_id: usuario.ubicacion_id
    },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({
    token,
    user: {
      id: usuario.id,
      nombre: usuario.nombre_completo,
      email: usuario.email,
      cargo: usuario.cargo,
      rol: rolClave,
      ubicacion: ubicacion || { id: usuario.ubicacion_id, nombre: 'Unknown' }
    }
  });
}

/**
 * POST /auth/login/2fa — segundo paso del login de admin con TOTP.
 * Body: { tempToken, code }
 */
const login2FA = async (req, res) => {
  try {
    const { tempToken, code } = req.body || {};
    const decoded = mfaService.verificarTempToken(tempToken, '2fa_login');
    if (!decoded) {
      return res.status(401).json({ error: 'Sesión 2FA inválida o expirada. Vuelve a iniciar sesión.' });
    }

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*, roles(clave)')
      .eq('id', decoded.id)
      .single();

    if (error || !usuario || !usuario.activo) {
      return res.status(401).json({ error: 'Usuario no válido' });
    }

    const codigo = String(code || '').trim();
    const esRespaldo = /^[A-Za-z0-9]{4,5}-?[A-Za-z0-9]{4,5}$/.test(codigo);

    let ok = false;
    if (esRespaldo && usuario.totp_backup_codes?.length) {
      const resultado = await mfaService.verificarCodigoRespaldo(usuario.totp_backup_codes, codigo);
      ok = resultado.ok;
      if (ok) {
        await supabase.from('usuarios')
          .update({ totp_backup_codes: resultado.hashesRestantes })
          .eq('id', usuario.id);
      }
    } else {
      ok = await mfaService.verificarTOTP(usuario.totp_secret, codigo);
    }

    if (!ok) {
      auditService.registrarDesdeReq(req, {
        usuarioId: usuario.id,
        tipoEvento: auditService.TIPOS.LOGIN_FALLIDO,
        accion: 'login_2fa',
        detalle: { motivo: esRespaldo ? 'codigo_respaldo_invalido' : 'totp_invalido' }
      });
      return res.status(403).json({ error: 'Código de verificación incorrecto' });
    }

    await emitirSesion(req, res, usuario, usuario.roles?.clave || 'admin');
  } catch (error) {
    console.error('Login 2FA error:', error);
    res.status(500).json({ error: 'Error en la verificación 2FA' });
  }
};

/**
 * POST /auth/2fa/setup — inicia el enrolamiento forzado (solo tempToken de
 * paso '2fa_enrolamiento'). Devuelve secreto, URI otpauth y códigos de respaldo.
 * Body: { tempToken }
 */
const setup2FA = async (req, res) => {
  try {
    const { tempToken } = req.body || {};
    const decoded = mfaService.verificarTempToken(tempToken, '2fa_enrolamiento');
    if (!decoded) {
      return res.status(401).json({ error: 'Sesión de enrolamiento inválida o expirada. Vuelve a iniciar sesión.' });
    }

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('id, email, nombre_completo, activo, roles(clave)')
      .eq('id', decoded.id)
      .single();

    if (error || !usuario || !usuario.activo) {
      return res.status(401).json({ error: 'Usuario no válido' });
    }

    const enrolamiento = await mfaService.generarEnrolamiento(usuario.email);

    const { error: upErr } = await supabase.from('usuarios')
      .update({
        totp_secret: enrolamiento.secretCifrado,
        totp_backup_codes: enrolamiento.backupHashes,
        totp_activo: false
      })
      .eq('id', usuario.id);

    if (upErr) {
      console.error('[2fa] error guardando secreto:', upErr.message);
      return res.status(500).json({ error: 'No se pudo iniciar el enrolamiento' });
    }

    res.json({
      secret: enrolamiento.secret,
      otpauthURI: enrolamiento.uri,
      backupCodes: enrolamiento.backupCodes
    });
  } catch (error) {
    console.error('Setup 2FA error:', error);
    res.status(500).json({ error: 'Error al configurar 2FA' });
  }
};

/**
 * POST /auth/2fa/verify-setup — confirma el primer código y activa el 2FA
 * (enrolamiento forzado). Emite la sesión definitiva.
 * Body: { tempToken, code }
 */
const verifySetup2FA = async (req, res) => {
  try {
    const { tempToken, code } = req.body || {};
    const decoded = mfaService.verificarTempToken(tempToken, '2fa_enrolamiento');
    if (!decoded) {
      return res.status(401).json({ error: 'Sesión de enrolamiento inválida o expirada. Vuelve a iniciar sesión.' });
    }

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*, roles(clave)')
      .eq('id', decoded.id)
      .single();

    if (error || !usuario || !usuario.activo || !usuario.totp_secret) {
      return res.status(401).json({ error: 'Usuario no válido o enrolamiento no iniciado' });
    }

    const ok = await mfaService.verificarTOTP(usuario.totp_secret, code);
    if (!ok) {
      auditService.registrarDesdeReq(req, {
        usuarioId: usuario.id,
        tipoEvento: auditService.TIPOS.LOGIN_FALLIDO,
        accion: 'login_2fa',
        detalle: { motivo: 'totp_invalido_en_enrolamiento' }
      });
      return res.status(403).json({ error: 'Código incorrecto: revisa tu app autenticadora' });
    }

    const { error: upErr } = await supabase.from('usuarios')
      .update({ totp_activo: true })
      .eq('id', usuario.id);
    if (upErr) {
      console.error('[2fa] error activando 2FA:', upErr.message);
      return res.status(500).json({ error: 'No se pudo activar el 2FA' });
    }

    await emitirSesion(req, res, usuario, usuario.roles?.clave || 'admin');
  } catch (error) {
    console.error('Verify setup 2FA error:', error);
    res.status(500).json({ error: 'Error al confirmar el 2FA' });
  }
};

/**
 * Register: Crea nuevo usuario con hash bcrypt automático
 */
const register = async (req, res) => {
  try {
    const { email, password, nombre_completo, ubicacion_id, rol, cargo } = req.body;

    // Acepta `rol` (clave) con fallback a `cargo` (legacy)
    const rolClave = rol || cargo;

    // Validar campos requeridos
    if (!email || !password || !nombre_completo || !ubicacion_id || !rolClave) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Validar que ubicacion existe
    const { data: ubicacion, error: ubError } = await supabase
      .from('ubicaciones')
      .select('id')
      .eq('id', ubicacion_id)
      .single();

    if (ubError || !ubicacion) {
      return res.status(400).json({ error: 'Invalid location ID' });
    }

    // Resolver rol_id desde la tabla roles por clave
    const { data: rolRecord, error: rolError } = await supabase
      .from('roles')
      .select('id')
      .eq('clave', rolClave)
      .single();

    if (rolError || !rolRecord) {
      return res.status(400).json({ error: `Invalid role: ${rolClave}` });
    }

    // Generar hash bcrypt de la contraseña
    const password_hash = await bcryptjs.hash(password, 10);

    // Insertar usuario en Supabase
    const { data: newUser, error: insertError } = await supabase
      .from('usuarios')
      .insert([
        {
          email: email.toLowerCase(),
          password_hash,
          nombre_completo,
          ubicacion_id,
          cargo: rolClave,
          rol_id: rolRecord.id,
          activo: true
        }
      ])
      .select('id, email, nombre_completo, cargo, rol_id')
      .single();

    if (insertError) {
      console.error('Insert error:', insertError);
      return res.status(400).json({ error: insertError.message });
    }

    // WMS 2.0 · A2: bitácora de cambios (alta de usuarios)
    auditService.registrarDesdeReq(req, {
      usuarioId: newUser.id,
      tipoEvento: auditService.TIPOS.CAMBIO,
      accion: 'usuario_creado',
      entidad: 'usuarios',
      entidadId: newUser.id,
      detalle: { email: newUser.email, rol: rolClave, ubicacion_id }
    });

    res.status(201).json({
      message: 'User created successfully',
      user: newUser
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
};

/**
 * Get user: Obtiene usuario actual desde token JWT
 */
const getUser = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*, roles(clave, nombre)')
      .eq('id', userId)
      .single();

    if (error || !usuario) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Obtener ubicacion
    const { data: ubicacion } = await supabase
      .from('ubicaciones')
      .select('id, nombre')
      .eq('id', usuario.ubicacion_id)
      .single();

    res.json({
      user: {
        id: usuario.id,
        nombre: usuario.nombre_completo,
        email: usuario.email,
        cargo: usuario.cargo,
        rol: usuario.roles?.clave || null,
        hasPin: Boolean(usuario.pin_hash),
        ubicacion: ubicacion || { id: usuario.ubicacion_id, nombre: 'Unknown' }
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
};

/**
 * Establecer o actualizar PIN de autorización (Jefe de Almacén o Admin)
 * POST /auth/set-pin
 * Body: { pin, password }
 */
const setPin = async (req, res) => {
  try {
    const userId = req.user.id;
    const { pin, password } = req.body;

    if (!pin || !password) {
      return res.status(400).json({ error: 'PIN y contraseña son requeridos' });
    }

    // Validar formato: 4 a 6 dígitos numéricos
    const pinStr = String(pin).trim();
    if (!/^\d{4,6}$/.test(pinStr)) {
      return res.status(400).json({ error: 'El PIN debe ser numérico de 4 a 6 dígitos' });
    }

    // Obtener usuario y validar password actual
    const { data: usuario, error: userError } = await supabase
      .from('usuarios')
      .select('id, password_hash, rol_id, cargo, roles(clave)')
      .eq('id', userId)
      .single();

    if (userError || !usuario) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    // WMS 2.0 · R1: el PIN lo configuran jefe_almacen, lider y admin.
    const rol = String(usuario.roles?.clave ?? '').toLowerCase().trim();
    const puedePin = rol === 'jefe_almacen' || rol === 'lider' || rol === 'admin';
    if (!puedePin) {
      return res.status(403).json({ error: 'Solo Jefes de Almacén, Líderes o Administradores pueden configurar un PIN' });
    }

    const passwordMatch = await bcryptjs.compare(password, usuario.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    // Hashear nuevo PIN con bcrypt
    const pinHash = await bcryptjs.hash(pinStr, 10);

    const { error: updateError } = await supabase
      .from('usuarios')
      .update({ pin_hash: pinHash })
      .eq('id', userId);

    if (updateError) {
      throw updateError;
    }

    // WMS 2.0 · A2: bitácora de cambios (el PIN es una credencial de autorización)
    auditService.registrarDesdeReq(req, {
      usuarioId: userId,
      tipoEvento: auditService.TIPOS.CAMBIO,
      accion: 'pin_configurado',
      entidad: 'usuarios',
      entidadId: userId
    });

    res.json({
      success: true,
      message: 'PIN configurado exitosamente'
    });
  } catch (error) {
    console.error('Error al configurar PIN:', error);
    res.status(500).json({ error: 'Error al configurar el PIN', details: error.message });
  }
};

/**
 * Logout: Invalida sesión en cliente
 */
const logout = (req, res) => {
  res.json({ message: 'Logged out successfully' });
};

/**
 * Generate hash: Genera hash bcrypt (SOLO PARA TESTING)
 */
const generateHash = async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    const hash = await bcryptjs.hash(password, 10);
    res.json({
      password,
      hash,
      length: hash.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = { login, login2FA, setup2FA, verifySetup2FA, register, getUser, setPin, logout, generateHash };
