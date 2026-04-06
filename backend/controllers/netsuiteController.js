const supabase = require('../config/supabase');
const { makeNetsuiteRequest } = require('../config/netsuite');

/**
 * Obtener IFs disponibles para una ubicación
 * Ejecuta búsqueda guardada en NetSuite
 */
const getIFs = async (req, res) => {
  try {
    const { ubicacion_id } = req.query;

    if (!ubicacion_id) {
      return res.status(400).json({ error: 'ubicacion_id is required' });
    }

    // Obtener datos de ubicación
    const { data: ubicacion, error: ubError } = await supabase
      .from('ubicaciones')
      .select('*')
      .eq('id', ubicacion_id)
      .single();

    if (ubError || !ubicacion) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // IMPORTANTE: Implementar búsqueda en NetSuite
    // Por ahora retornamos estructura de ejemplo
    // En producción, llamar makeNetsuiteRequest para ejecutar búsqueda guardada

    const mockIFs = [
      {
        tranid: 'IF-2024-001',
        description: 'Descripción del producto 1',
        ubicacion: ubicacion.nombre
      },
      {
        tranid: 'IF-2024-002',
        description: 'Descripción del producto 2',
        ubicacion: ubicacion.nombre
      }
    ];

    res.json({
      ifs: mockIFs,
      ubicacion: ubicacion.nombre
    });
  } catch (error) {
    console.error('Get IFs error:', error);
    res.status(500).json({ error: 'Failed to get IFs', details: error.message });
  }
};

/**
 * Convertir base64 a Buffer
 */
function base64ToBuffer(base64String) {
  // Eliminar prefijo data:image/png;base64, si existe
  const base64Data = base64String.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Crear carpeta en NetSuite File Cabinet (placeholder)
 * En producción, implementar con SuiteTalk/REST API
 */
async function createFileCabinetFolder(folderPath) {
  console.log(`📁 Creating folder: ${folderPath}`);
  // TODO: Implementar con NetSuite API
  return { id: 'folder_id_placeholder' };
}

/**
 * Subir archivo PNG a NetSuite File Cabinet (placeholder)
 * En producción, implementar con SuiteTalk/REST API
 */
async function uploadFileToNetSuite(fileBuffer, fileName, folderPath) {
  console.log(`📤 Uploading: ${fileName} to ${folderPath}`);
  console.log(`   Size: ${fileBuffer.length} bytes`);
  // TODO: Implementar con NetSuite REST API
  // Usar endpoint: axios.post(`${baseUrl}/rest/record/v1/file`, ...)
  return {
    success: true,
    fileName: fileName,
    url: `${process.env.NETSUITE_ACCOUNT_ID}/files/${fileName}`,
    internalId: 'file_internal_id_placeholder'
  };
}

/**
 * Enviar datos de escaneo y firmas a NetSuite File Cabinet
 */
const submitData = async (req, res) => {
  try {
    const { ifTranid, ubicacion_id, items, signatures } = req.body;
    const userId = req.user.id;

    if (!ifTranid || !ubicacion_id || !items || !signatures) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Obtener info de ubicación
    const { data: ubicacion } = await supabase
      .from('ubicaciones')
      .select('*')
      .eq('id', ubicacion_id)
      .single();

    if (!ubicacion) {
      return res.status(404).json({ error: 'Location not found' });
    }

    // ──────────────────────────────────────────────────────
    // Procesamiento de firmas
    // ──────────────────────────────────────────────────────

    const folderName = `${ifTranid}_Almacen`;
    const uploadedFiles = [];

    console.log(`\n📋 Processing submission for IF: ${ifTranid}`);
    console.log(`   Location: ${ubicacion.nombre}`);
    console.log(`   Items: ${items.length}`);
    console.log(`   Folder: ${folderName}\n`);

    // Crear carpeta en NetSuite File Cabinet
    try {
      await createFileCabinetFolder(folderName);
    } catch (error) {
      console.error('Error creating folder:', error.message);
      // Continuar aunque falle la carpeta
    }

    // Procesar cada firma
    const signatureMap = {
      auxAlmacen: { label: 'Auxiliar', displayName: 'Aux. de Almacén' },
      jefeAlmacen: { label: 'Jefe', displayName: 'Jefe de Almacén' },
      gerente: { label: 'Gerente', displayName: 'Gerente' },
      cliente: { label: 'Cliente', displayName: 'Cliente' }
    };

    for (const [sigType, sigData] of Object.entries(signatures)) {
      if (sigData && signatureMap[sigType]) {
        try {
          const fileBuffer = base64ToBuffer(sigData);
          const fileName = `firma_${sigType}.png`;
          const filePath = `${folderName}/${fileName}`;

          const uploadResult = await uploadFileToNetSuite(
            fileBuffer,
            fileName,
            folderName
          );

          uploadedFiles.push({
            type: sigType,
            label: signatureMap[sigType].displayName,
            filename: fileName,
            size: fileBuffer.length,
            ...uploadResult
          });

          console.log(`✓ Uploaded: ${fileName}`);
        } catch (error) {
          console.error(`✗ Error uploading ${sigType}:`, error.message);
        }
      }
    }

    // ──────────────────────────────────────────────────────
    // Respuesta de éxito
    // ──────────────────────────────────────────────────────

    const response = {
      status: 'success',
      message: 'Data successfully submitted to NetSuite',
      ifTranid,
      location: ubicacion.nombre,
      itemsCount: items.length,
      signaturesCount: Object.keys(signatures).length,
      uploadedFiles: uploadedFiles,
      timestamp: new Date().toISOString(),
      details: {
        folder: folderName,
        filesProcessed: uploadedFiles.length,
        totalSignatures: Object.entries(signatures).filter(([_, v]) => v).length
      }
    };

    console.log(`\n✓ Submission complete:`);
    console.log(`  - IF: ${ifTranid}`);
    console.log(`  - Items: ${items.length}`);
    console.log(`  - Signatures: ${uploadedFiles.length}`);
    console.log(`  - Folder: /${folderName}\n`);

    res.json(response);

  } catch (error) {
    console.error('Submit data error:', error);
    res.status(500).json({
      error: 'Failed to submit data',
      details: error.message
    });
  }
};

module.exports = {
  getIFs,
  submitData
};
