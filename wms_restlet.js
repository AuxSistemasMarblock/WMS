/**
 * @NApiVersion 2.x
 * @NScriptType RESTlet
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/record', 'N/error'], function(file, record, error) {

    function handlePost(requestBody) {
        try {
            var request = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;

            // Si es acción de actualizar status del IF
            if (request.action === 'updateIFStatus') {
                return updateIFStatus(request);
            }

            // Validar que lleguen los datos para upload de archivo
            if (!request.filename || !request.contents || !request.folder_id) {
                throw error.create({
                    name: 'INVALID_REQUEST',
                    message: 'Faltan: filename, contents (base64), folder_id'
                });
            }

            // Crear archivo (contents es base64)
            var fileObj = file.create({
                name: request.filename,
                fileType: file.Type.PNGIMAGE,
                contents: request.contents, // base64 string
                folder: request.folder_id
            });

            // Guardar archivo
            var fileId = fileObj.save();

            // Retornar resultado
            return {
                success: true,
                fileId: fileId,
                filename: request.filename,
                folderId: request.folder_id,
                url: fileObj.url
            };

        } catch (e) {
            return {
                success: false,
                error: e.message,
                code: e.code
            };
        }
    }

    function updateIFStatus(data) {
        try {
            if (!data.internalId) {
                throw error.create({
                    name: 'INVALID_REQUEST',
                    message: 'Falta internalId del Item Fulfillment'
                });
            }

            log.debug('updateIFStatus', 'Intentando actualizar IF: ' + data.internalId);

            // Cargar el registro Item Fulfillment
            var ifRecord = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: data.internalId
            });

            // Obtener status actual para debug
            var currentStatus = ifRecord.getValue('shipstatus');
            log.debug('updateIFStatus', 'Status actual: ' + currentStatus);

            // Actualizar shipstatus a 'C' (Enviado)
            ifRecord.setValue('shipstatus', 'C');

            // Guardar el registro
            var recordId = ifRecord.save();

            log.debug('updateIFStatus', 'IF actualizado exitosamente. ID: ' + recordId);

            return {
                success: true,
                recordId: recordId,
                message: 'IF status updated to C',
                previousStatus: currentStatus
            };

        } catch (e) {
            log.error('updateIFStatus Error', e);
            return {
                success: false,
                error: e.message,
                code: e.code
            };
        }
    }

    return {
        post: handlePost
    };
});