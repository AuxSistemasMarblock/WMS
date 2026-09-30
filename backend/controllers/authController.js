const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const supabase = require('../config/supabase');

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
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Validar contraseña contra hash bcrypt
    const passwordMatch = await bcryptjs.compare(password, usuario.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!usuario.activo) {
      return res.status(403).json({ error: 'User is inactive' });
    }

    // Obtener ubicacion del usuario
    const { data: ubicacion } = await supabase
      .from('ubicaciones')
      .select('id, nombre')
      .eq('id', usuario.ubicacion_id)
      .single();

    // Generar JWT token
    const token = jwt.sign(
      {
        id: usuario.id,
        email: usuario.email,
        nombre: usuario.nombre_completo,
        cargo: usuario.cargo,
        rol: usuario.roles?.clave ?? usuario.cargo,
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
        rol: usuario.roles?.clave ?? usuario.cargo,
        ubicacion: ubicacion || { id: usuario.ubicacion_id, nombre: 'Unknown' }
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
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
        rol: usuario.roles?.clave ?? usuario.cargo,
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

    const rol = (usuario.roles?.clave || usuario.cargo || '').toLowerCase();
    const esJefeOAdmin = rol.includes('jefe') || rol === 'admin' || rol === 'gerente';
    if (!esJefeOAdmin) {
      return res.status(403).json({ error: 'Solo los Jefes de Almacén o Administradores pueden configurar un PIN' });
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

module.exports = { login, register, getUser, setPin, logout, generateHash };
