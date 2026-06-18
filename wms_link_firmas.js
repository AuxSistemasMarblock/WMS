/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Recorre el File Cabinet y, para cada tipo de firma, busca el archivo
 * {tranid}_{tipo}.png dentro de la carpeta correspondiente. Si existe y el
 * custom field del IF no coincide, lo actualiza via submitFields.
 *
 * Se ejecuta en afterSubmit (no beforeLoad) para evitar el patrón
 * "escritura durante beforeLoad" y la potencial recursión.
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    // ===== MAPEO TIPO DE FIRMA → (FOLDER ID, CUSTOM FIELD DEL IF) =====
    // IDs de folder y field IDs deben coincidir con backend/config/environments.js §6.8
    const FIRMAS = [
        { tipo: 'auxAlmacen',  folderId: 12848, fieldId: 'custbody60' },
        { tipo: 'cliente',     folderId: 12849, fieldId: 'custbody61' },
        { tipo: 'jefeAlmacen', folderId: 12850, fieldId: 'custbody62' },
        { tipo: 'gerente',     folderId: 12851, fieldId: 'custbody63' }
    ];

    const afterSubmit = (scriptContext) => {
        // Solo actuar en create/edit (XEDIT evita doble disparo en impresión)
        if (scriptContext.type !== scriptContext.UserEventType.CREATE &&
            scriptContext.type !== scriptContext.UserEventType.EDIT) return;

        const newRecord = scriptContext.newRecord;
        const tranId = newRecord.getValue({ fieldId: 'tranid' });
        if (!tranId) return;

        const valuesToUpdate = {};
        const found = [];

        for (const firma of FIRMAS) {
            const filename = `${tranId}_${firma.tipo}.png`;
            let fileId = null;

            try {
                const result = search.create({
                    type: 'file',
                    filters: [
                        ['name', 'is', filename], 'AND',
                        ['folder', 'anyof', firma.folderId]
                    ]
                }).run().getRange({ start: 0, end: 1 });

                if (result.length > 0) {
                    fileId = result[0].id;
                }
            } catch (e) {
                log.error(`Error buscando ${filename}`, e);
                continue; // no abortar el resto
            }

            // Comparar con el valor actual
            const currentValue = newRecord.getValue({ fieldId: firma.fieldId });
            if (fileId && String(currentValue) !== String(fileId)) {
                valuesToUpdate[firma.fieldId] = fileId;
            }
            found.push({ tipo: firma.tipo, fileId, currentValue });
        }

        // Un solo submitFields con todos los cambios
        if (Object.keys(valuesToUpdate).length > 0) {
            try {
                record.submitFields({
                    type: newRecord.type,
                    id: newRecord.id,
                    values: valuesToUpdate
                });
                log.audit('Firmas vinculadas', { tranId, ...valuesToUpdate });
            } catch (e) {
                log.error(`Error al guardar fileIds para ${tranId}`, e);
            }
        }

        log.debug('Resumen', { tranId, found });
    };

    return { afterSubmit };
});