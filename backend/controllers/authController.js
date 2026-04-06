const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const supabase = require('../config/supabase');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Buscar usuario en Supabase
    const { data: usuarios, error: queryError } = await supabase
      .from('usuarios')
      .select('*, ubicaciones(id, nombre, netsuite_id, codigo)')
      .eq('email', email.toLowerCase())
      .single();

    if (queryError || !usuarios) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Validar contraseña
    const passwordMatch = await bcryptjs.compare(password, usuarios.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!usuarios.activo) {
      return res.status(403).json({ error: 'User is inactive' });
    }

    // Generar JWT
    const token = jwt.sign(
      {
        id: usuarios.id,
        email: usuarios.email,
        nombre: usuarios.nombre_completo,
        ubicacion: usuarios.ubicaciones,
        cargo: usuarios.cargo
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: usuarios.id,
        nombre: usuarios.nombre_completo,
        email: usuarios.email,
        cargo: usuarios.cargo,
        ubicacion: usuarios.ubicaciones
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed', details: error.message });
  }
};

const getUser = async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: usuario, error } = await supabase
      .from('usuarios')
      .select('*, ubicaciones(id, nombre, netsuite_id, codigo)')
      .eq('id', userId)
      .single();

    if (error || !usuario) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: usuario.id,
        nombre: usuario.nombre_completo,
        email: usuario.email,
        cargo: usuario.cargo,
        ubicacion: usuario.ubicaciones
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
};

const logout = (req, res) => {
  // JWT es stateless, logout solo ocurre en cliente
  res.json({ message: 'Logged out successfully' });
};

module.exports = { login, getUser, logout };
