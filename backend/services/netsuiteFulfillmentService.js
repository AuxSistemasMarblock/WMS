/**
 * Servicio para consultar líneas y detalle de inventario (lotes) de Item Fulfillments
 * directamente desde NetSuite SuiteTalk REST Web Services.
 *
 * Utilizado por la confronta en vivo del scanner (WMS) para validar órdenes
 * en estado Empaquetado / Pendientes de salida.
 */

const axios = require('axios');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const config = require('../config/environments');
const netsuiteRestletClient = require('../config/netsuiteRestlet');

/**
 * Normaliza SKU removiendo el prefijo "ART" común en NetSuite si existe
 * Ej: "ART504XPB" -> "504XPB", "504XPB" -> "504XPB"
 */
function cleanSku(val) {
  if (!val) return '';
  return String(val).trim().replace(/^ART/i, '');
}

/**
 * Extrae el identificador de Sales Order del texto createdFrom
 * Ej: "Orden de venta #SO14627" -> "SO14627"
 */
function extractSo(val) {
  if (!val) return null;
  const match = String(val).match(/SO\d+/i);
  return match ? match[0].toUpperCase() : String(val).trim();
}

/**
 * Instancia de OAuth 1.0a para SuiteTalk REST API
 */
function getOAuthClient() {
  return new OAuth({
    consumer: {
      key: config.netsuite.clientId,
      secret: config.netsuite.clientSecret
    },
    signature_method: 'HMAC-SHA256',
    realm: config.netsuite.realm,
    hash_function(base_string, key) {
      return crypto
        .createHmac('sha256', key)
        .update(base_string)
        .digest('base64');
    }
  });
}

/**
 * Obtener base URL de SuiteTalk REST API
 */
function getSuiteTalkHost() {
  const accountId = String(config.netsuite.accountId || '').toLowerCase().replace(/_/g, '-');
  return `https://${accountId}.suitetalk.api.netsuite.com`;
}

/**
 * Consulta un Item Fulfillment por su internalId vía SuiteTalk REST API
 * y retorna la estructura esperada por confrontaService.
 *
 * @param {string|number} internalId - ID interno de la IF en NetSuite (ej: 178176)
 * @param {string} [fallbackTranid] - Tranid de respaldo (ej: "IF14647")
 * @returns {Promise<Object>} IF normalizada con sus líneas y lotes
 */
async function getIFEsperadaPorId(internalId, fallbackTranid = null) {
  if (!internalId) {
    throw new Error('internalId es requerido para consultar la IF en SuiteTalk');
  }

  const host = getSuiteTalkHost();
  const endpoint = `/services/rest/record/v1/itemFulfillment/${internalId}?expandSubResources=true`;
  const fullUrl = `${host}${endpoint}`;

  const oauth = getOAuthClient();
  const authHeader = oauth.toHeader(
    oauth.authorize(
      { url: fullUrl, method: 'GET' },
      { key: config.netsuite.tokenId, secret: config.netsuite.tokenSecret }
    )
  );

  const response = await axios.get(fullUrl, {
    headers: {
      'Authorization': authHeader.Authorization,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    timeout: 15000
  });

  const data = response.data;
  if (!data) {
    throw new Error(`Respuesta vacía de NetSuite para la IF ${internalId}`);
  }

  const ifTranid = data.tranId || fallbackTranid;
  const ifLocation = data.location?.refName || '';
  const sourceDoc = extractSo(data.createdFrom?.refName);
  const trandate = data.tranDate || '';

  const lineas = [];
  const rawItems = data.item?.items || [];

  for (const it of rawItems) {
    const rawSku = it.itemName || it.itemUpc || it.item?.refName || '';
    const sku = cleanSku(rawSku);
    const itemLoc = it.location?.refName || ifLocation;
    const assignments = it.inventoryDetail?.inventoryAssignment?.items || [];

    if (assignments.length > 0) {
      for (const asgn of assignments) {
        lineas.push({
          internalid: String(data.id || internalId),
          tranid: ifTranid,
          trandate,
          location: itemLoc,
          sourceDoc,
          sku,
          lote: asgn.issueInventoryNumber?.refName || null,
          quantity: parseFloat(asgn.quantity) || 0,
          expectedLocation: itemLoc
        });
      }
    } else {
      lineas.push({
        internalid: String(data.id || internalId),
        tranid: ifTranid,
        trandate,
        location: itemLoc,
        sourceDoc,
        sku,
        lote: null,
        quantity: parseFloat(it.quantity) || 0,
        expectedLocation: itemLoc
      });
    }
  }

  return {
    internalid: String(data.id || internalId),
    tranid: ifTranid,
    trandate,
    location: ifLocation || lineas[0]?.location || '',
    sourceDoc,
    lineas
  };
}

/**
 * Resuelve el internalId de una IF a partir de su tranid consultando la saved search de IFs pendientes.
 *
 * @param {string} tranid - Ej: "IF14647"
 * @returns {Promise<string|null>} internalId o null
 */
async function resolverInternalIdPorTranid(tranid) {
  if (!tranid) return null;
  const cleanTranid = String(tranid).trim().toUpperCase();

  try {
    const searchPayload = {
      searchId: config.netsuite.searchRestlet.searchId,
      limit: 1000,
      start: 0
    };
    const searchUrl = `/app/site/hosting/restlet.nl?script=${config.netsuite.searchRestlet.scriptId}&deploy=${config.netsuite.searchRestlet.deployId}`;
    const searchResponse = await netsuiteRestletClient.post(searchUrl, searchPayload);

    const rows = searchResponse.data?.data || [];
    const match = rows.find(r => String(r.tranid || '').trim().toUpperCase() === cleanTranid);
    return match?.id ? String(match.id) : null;
  } catch (err) {
    console.warn(`[netsuiteFulfillmentService] No se pudo resolver internalId para ${cleanTranid}:`, err.message);
    return null;
  }
}

module.exports = {
  getIFEsperadaPorId,
  resolverInternalIdPorTranid,
  cleanSku,
  extractSo
};
