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

    // Buscar usuario en Supabase
    const { data: usuario, error: queryError } = await supabase
      .from('usuarios')
      .select('*')
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
    const { email, password, nombre_completo, ubicacion_id, cargo } = req.body;

    // Validar campos requeridos
    if (!email || !password || !nombre_completo || !ubicacion_id || !cargo) {
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
          cargo,
          activo: true
        }
      ])
      .select('id, email, nombre_completo, cargo')
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
      .select('*')
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
        ubicacion: ubicacion || { id: usuario.ubicacion_id, nombre: 'Unknown' }
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
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

module.exports = { login, register, getUser, logout, generateHash };
