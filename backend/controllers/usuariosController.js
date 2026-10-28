/**
 * WMS · Controller de gestión de Usuarios (WMS 2.0 · R2)
 *
 * CRUD completo para el rol admin desde la interfaz (reemplaza el flujo
 * manual de curl /auth/register). Cada cambio queda en la bitácora de
 * auditoría (audit_logs — A2).
 *
 *  - GET    /api/usuarios              listado con filtros
 *  - GET    /api/usuarios/catalogos    roles + ubicaciones para formularios
 *  - POST   /api/usuarios              alta (reutiliza authController.register)
 *  - PATCH  /api/usuarios/:id          edición (nombre/rol/ubicación/activo)
 *  - POST   /api/usuarios/:id/password reset de contraseña
 */

const bcryptjs = require('bcryptjs');
const supabase = require('../config/supabase');
const auditService = require('../services/auditService');

/**
 * GET /api/usuarios?q=&rol=&activo=
 */
const getUsuarios = async (req, res) => {
  try {
    const { q, rol } = req.query;
    const activo = req.query.activo;

    let query = supabase
      .from('usuarios')
      .select('id, email, nombre_completo, cargo, activo, ultimo_login, ubicacion_id, rol_id, roles(clave, nombre), ubicaciones(id, nombre), pin_hash, totp_secret, totp_activo')
      .order('nombre_completo', { ascending: true });

    if (rol) query = query.eq('roles.clave', String(rol));
    if (activo === 'true' || activo === 'false') query = query.eq('activo', activo === 'true');

    const { data, error } = await query;
    if (error) {
      console.error('[usuarios] error listando:', error.message);
      return res.status(500).json({ error: 'Error listando usuarios' });
    }

    const limpio = String(q || '').trim().toLowerCase();
    const usuarios = (data || [])
      .map(u => ({
        id: u.id,
        email: u.email,
        nombre_completo: u.nombre_completo,
        rol: u.roles?.clave || null,
        rol_nombre: u.roles?.nombre || null,
        ubicacion_id: u.ubicacion_id,
        ubicacion: u.ubicaciones?.nombre || null,
        activo: u.activo,
        ultimo_login: u.ultimo_login,
        tiene_pin: Boolean(u.pin_hash),
        totp_activo: Boolean(u.totp_activo)
      }))
      .filter(u => !limpio
        || (u.email || '').toLowerCase().includes(limpio)
        || (u.nombre_completo || '').toLowerCase().includes(limpio));

    res.json({ usuarios });
  } catch (e) {
    console.error('getUsuarios error:', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * GET /api/usuarios/catalogos
 */
const getCatalogos = async (req, res) => {
  try {
    const [rolesRes, ubicRes] = await Promise.all([
      supabase.from('roles').select('id, clave, nombre').order('id'),
      supabase.from('ubicaciones').select('id, nombre').order('nombre')
    ]);

    if (rolesRes.error || ubicRes.error) {
      return res.status(500).json({ error: 'Error cargando catálogos' });
    }

    res.json({
      roles: rolesRes.data || [],
      ubicaciones: ubicRes.data || []
    });
  } catch (e) {
    console.error('getCatalogos error:', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * PATCH /api/usuarios/:id — edición de nombre, rol, ubicación y estado.
 * Body opcional: { nombre_completo, rol (clave), ubicacion_id, activo }
 */
const putUsuario = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Id inválido' });
    }

    const { data: actual, error: errActual } = await supabase
      .from('usuarios')
      .select('id, email, nombre_completo, activo, ubicacion_id, rol_id, roles(clave)')
      .eq('id', id)
      .single();

    if (errActual || !actual) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const cambios = {};
    const detalle = {};

    if (req.body.nombre_completo !== undefined) {
      const nombre = String(req.body.nombre_completo || '').trim();
      if (!nombre) return res.status(400).json({ error: 'nombre_completo no puede estar vacío' });
      if (nombre !== actual.nombre_completo) {
        cambios.nombre_completo = nombre;
        detalle.nombre_completo = { de: actual.nombre_completo, a: nombre };
      }
    }

    if (req.body.rol !== undefined) {
      const clave = String(req.body.rol || '').toLowerCase().trim();
      const { data: rolRow, error: errRol } = await supabase
        .from('roles')
        .select('id, clave')
        .eq('clave', clave)
        .single();
      if (errRol || !rolRow) {
        return res.status(400).json({ error: `Rol inválido: ${clave}` });
      }
      if (rolRow.id !== actual.rol_id) {
        cambios.rol_id = rolRow.id;
        cambios.cargo = rolRow.clave; // mantener cargo legacy consistente
        detalle.rol = { de: actual.roles?.clave || null, a: rolRow.clave };
      }
    }

    if (req.body.ubicacion_id !== undefined) {
      const ubicacionId = Number(req.body.ubicacion_id);
      if (!Number.isInteger(ubicacionId) || ubicacionId <= 0) {
        return res.status(400).json({ error: 'ubicacion_id inválido' });
      }
      const { data: ubicRow, error: errUb } = await supabase
        .from('ubicaciones')
        .select('id')
        .eq('id', ubicacionId)
        .single();
      if (errUb || !ubicRow) {
        return res.status(400).json({ error: 'Ubicación inválida' });
      }
      if (ubicacionId !== actual.ubicacion_id) {
        cambios.ubicacion_id = ubicacionId;
        detalle.ubicacion_id = { de: actual.ubicacion_id, a: ubicacionId };
      }
    }

    if (req.body.activo !== undefined) {
      const activo = Boolean(req.body.activo);
      if (activo !== actual.activo) {
        // Protección: un admin no puede desactivarse a sí mismo (evita lockout)
        if (!activo && id === req.user?.id) {
          return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
        }
        cambios.activo = activo;
        detalle.activo = { de: actual.activo, a: activo };
      }
    }

    if (Object.keys(cambios).length === 0) {
      return res.json({ message: 'Sin cambios', usuario: actual });
    }

    const { data: actualizado, error: errUp } = await supabase
      .from('usuarios')
      .update(cambios)
      .eq('id', id)
      .select('id, email, nombre_completo, activo, ubicacion_id, rol_id')
      .single();

    if (errUp) {
      console.error('[usuarios] error actualizando:', errUp.message);
      return res.status(500).json({ error: 'No se pudo actualizar el usuario' });
    }

    // WMS 2.0 · A2: bitácora de cambios
    auditService.registrarDesdeReq(req, {
      usuarioId: id,
      tipoEvento: auditService.TIPOS.CAMBIO,
      accion: cambios.activo === false ? 'usuario_desactivado'
        : (cambios.activo === true ? 'usuario_activado' : 'usuario_editado'),
      entidad: 'usuarios',
      entidadId: id,
      detalle
    });

    res.json({ message: 'Usuario actualizado', usuario: actualizado, cambios: detalle });
  } catch (e) {
    console.error('putUsuario error:', e);
    res.status(500).json({ error: e.message });
  }
};

/**
 * POST /api/usuarios/:id/password — reset de contraseña por el admin.
 * Body: { nueva_password }
 */
const postResetPassword = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Id inválido' });
    }

    const nueva = String(req.body?.nueva_password || '');
    if (nueva.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    const { data: usuario, error: errUser } = await supabase
      .from('usuarios')
      .select('id, email')
      .eq('id', id)
      .single();
    if (errUser || !usuario) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const password_hash = await bcryptjs.hash(nueva, 10);
    const { error: errUp } = await supabase
      .from('usuarios')
      .update({ password_hash })
      .eq('id', id);
    if (errUp) {
      console.error('[usuarios] error reseteando contraseña:', errUp.message);
      return res.status(500).json({ error: 'No se pudo resetear la contraseña' });
    }

    // WMS 2.0 · A2: bitácora de cambios (sin exponer la contraseña)
    auditService.registrarDesdeReq(req, {
      usuarioId: id,
      tipoEvento: auditService.TIPOS.CAMBIO,
      accion: 'password_reiniciada',
      entidad: 'usuarios',
      entidadId: id,
      detalle: { email: usuario.email, por: req.user?.id }
    });

    res.json({ message: 'Contraseña actualizada' });
  } catch (e) {
    console.error('postResetPassword error:', e);
    res.status(500).json({ error: e.message });
  }
};

module.exports = { getUsuarios, getCatalogos, putUsuario, postResetPassword };
