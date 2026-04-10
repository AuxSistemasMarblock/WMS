/**
 * @NApiVersion 2.x
 * @NScriptType RESTlet
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/error'], function(file, error) {
    
    function handlePost(requestBody) {
        try {
            var request = typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody;
            
            // Validar que lleguen los datos
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
    
    return {
        post: handlePost
    };
});