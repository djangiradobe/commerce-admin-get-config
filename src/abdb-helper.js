"use strict";
/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/
Object.defineProperty(exports, "__esModule", { value: true });
const { generateAccessToken } = require('@adobe/aio-lib-core-auth');
const libDb = require('@adobe/aio-lib-db');
const COLLECTION_IMPORT_QUEUE = 'import_queue';
const IMPORT_PIPELINE_COLLECTIONS = [COLLECTION_IMPORT_QUEUE];
const ABDB_SCOPES = ['adobeio.abdata.read', 'adobeio.abdata.write', 'adobeio.abdata.manage'];
function isUnsetOauthInput(value) {
    if (value == null || value === '')
        return true;
    const s = String(value).trim();
    return s === '' || s.startsWith('$');
}
function normalizeScopesToArray(scopes) {
    if (!scopes)
        return [];
    if (Array.isArray(scopes))
        return scopes.filter(Boolean).map(String);
    const s = String(scopes).trim();
    if (!s)
        return [];
    return s.split(/[\s,]+/).filter(Boolean);
}
/**
 * Get ABDB client. Requires action to have include-ims-credentials: true.
 *
 * Region resolution (first non-empty wins):
 *   1. options.region              — explicit override at the call site
 *   2. params.AIO_DB_REGION        — action input from ext.config.yaml
 *   3. process.env.AIO_DB_REGION   — local .env when running aio app run
 *
 * Throws if none is configured — we never silently pick a region for you.
 *
 * @param {object} params - Action params (must contain OAuth credentials for generateAccessToken)
 * @param {object} [options]
 * @param {string} [options.region] - explicit region override
 * @returns {Promise<{client: object, close: function}>}
 */
// Connection reuse across WARM action invocations. Each action container that
// bundles this helper keeps a single connected client and reuses it, instead
// of minting an IMS token + init + connect on every request (pure latency on a
// warm container). The connection is refreshed after CLIENT_TTL_MS (bounds
// staleness / token age), and rebuilt on connect failure. The `close()` we
// hand callers is a NO-OP so their `finally { close() }` doesn't tear down the
// shared connection — the container's teardown reclaims it.
let _cachedClient = null;
let _cachedRegion = null;
let _cachedAt = 0;
const CLIENT_TTL_MS = 10 * 60 * 1000;
const NOOP_CLOSE = async () => { };
async function getClient(params, options = {}) {
    const region = (options.region || params?.AIO_DB_REGION || process.env.AIO_DB_REGION || '').trim();
    if (!region) {
        throw new Error('ABDB region not configured: set AIO_DB_REGION in .env and pass it through ext.config.yaml inputs');
    }
    const now = Date.now();
    if (_cachedClient && _cachedRegion === region && (now - _cachedAt) < CLIENT_TTL_MS) {
        return { client: _cachedClient, close: NOOP_CLOSE };
    }
    // Refresh: drop a stale/expired connection before opening a new one so we
    // don't leak the old socket.
    if (_cachedClient) {
        try {
            await _cachedClient.close();
        }
        catch (_) { /* ignore */ }
        _cachedClient = null;
    }
    const tokenResponse = await generateAccessToken(params);
    const token = tokenResponse.access_token || tokenResponse;
    const db = await libDb.init({ token, region });
    const client = await db.connect();
    _cachedClient = client;
    _cachedRegion = region;
    _cachedAt = now;
    return { client, close: NOOP_CLOSE };
}
/** Force the next getClient() to reconnect — call after a connection error. */
function resetClientCache() {
    if (_cachedClient) {
        try {
            _cachedClient.close();
        }
        catch (_) { }
    }
    _cachedClient = null;
    _cachedRegion = null;
    _cachedAt = 0;
}
/**
 * Get collection by name
 * @param {object} client - ABDB client from getClient()
 * @param {string} collectionName - Collection name
 * @returns {Promise<object>} MongoDB-style collection
 */
async function getCollection(client, collectionName) {
    return client.collection(collectionName);
}
/**
 * Get collection by name
 * @param {object} client - ABDB client from getClient()
 * @param {string} collectionName - Collection name
 * @returns {Promise<object>} MongoDB-style collection
 */
function getCollectionByName(client, collectionName) {
    return client.collection(collectionName);
}
/**
 * Normalize listCollections API response to a Set of collection names.
 * @param {*} raw
 * @returns {Set<string>}
 */
function collectionNamesFromListResponse(raw) {
    const out = new Set();
    if (!raw)
        return out;
    const visit = (item) => {
        if (typeof item === 'string') {
            out.add(item);
            return;
        }
        if (item && typeof item === 'object') {
            const n = item.name ?? item.collectionName;
            if (typeof n === 'string')
                out.add(n);
        }
    };
    if (Array.isArray(raw)) {
        raw.forEach(visit);
        return out;
    }
    if (typeof raw === 'object') {
        const nested = raw.collections ?? raw.cursor?.firstBatch ?? raw.data;
        if (Array.isArray(nested)) {
            nested.forEach(visit);
        }
    }
    return out;
}
/**
 * Ensure import pipeline collections exist in ABDB (recreate if dropped in console).
 * Uses listCollections when possible; falls back to createCollection with duplicate tolerance.
 *
 * @param {object} client - DbClient from getClient().client
 * @param {object} [options]
 * @param {{ info?: function, warn?: function }} [options.logger] - optional aio logger
 * @returns {Promise<void>}
 */
async function ensureImportCollectionsExist(client, options = {}) {
    const log = options.logger || { info: () => { }, warn: () => { } };
    let existing = new Set();
    try {
        const raw = await client.listCollections({});
        existing = collectionNamesFromListResponse(raw);
    }
    catch (e) {
        log.warn(`ensureImportCollectionsExist: listCollections failed (${e.message}); attempting createCollection for each pipeline collection`);
    }
    const created = [];
    for (const name of IMPORT_PIPELINE_COLLECTIONS) {
        if (existing.has(name))
            continue;
        try {
            await client.createCollection(name);
            created.push(name);
        }
        catch (err) {
            const m = (err && err.message) ? String(err.message) : String(err);
            if (/exist|already|duplicate/i.test(m)) {
                continue;
            }
            throw err;
        }
    }
    if (created.length) {
        log.info(`ensureImportCollectionsExist: created ABDB collections: ${created.join(', ')}`);
    }
}
/**
 * OAuth Server-to-Server (client_credentials) via @adobe/aio-lib-ims — same pattern as workspace .env OAUTH_*.
 *
 * @param {object} params - Must include OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_ORG_ID; OAUTH_SCOPES merged with ABDB scopes
 * @returns {Promise<string|null>} token or null if required params are missing
 */
async function fetchImsTokenFromClientCredentials(params = {}) {
    const clientId = params.OAUTH_CLIENT_ID;
    const clientSecret = params.OAUTH_CLIENT_SECRET;
    const orgId = params.OAUTH_ORG_ID;
    if (isUnsetOauthInput(clientId) || isUnsetOauthInput(clientSecret) || isUnsetOauthInput(orgId)) {
        return null;
    }
    const extra = normalizeScopesToArray(params.OAUTH_SCOPES);
    const scopes = [...new Set([...ABDB_SCOPES, ...extra])];
    if (scopes.length === 0) {
        throw new Error('No IMS scopes resolved for ABDB; set OAUTH_SCOPES or rely on default ABDB scopes');
    }
    const { Ims } = require('@adobe/aio-lib-ims');
    const ims = new Ims();
    const tokenResult = await ims.getAccessTokenByClientCredentials(clientId, clientSecret, orgId, scopes);
    const token = tokenResult?.access_token?.token ||
        (typeof tokenResult?.payload?.access_token === 'string' ? tokenResult.payload.access_token : null);
    if (!token) {
        throw new Error(`IMS client_credentials failed or returned no token: ${JSON.stringify(tokenResult?.payload || tokenResult)}`);
    }
    return token;
}
/**
 * Resolve IMS bearer token for ABDB.
 * Order: options.token → params access_token → AIO_DB_IMS_TOKEN → OAUTH_* client_credentials (@adobe/aio-lib-ims) → @adobe/aio-lib-core-auth
 *
 * @param {object} params - Runtime action params
 * @param {object} options - { token?: string }
 * @returns {Promise<string>}
 */
async function resolveImsToken(params = {}, options = {}) {
    if (options.token != null && String(options.token).trim() !== '') {
        return String(options.token).trim();
    }
    const fromParams = params.access_token || params.ACCESS_TOKEN || params.__oauth?.access_token;
    if (fromParams != null && String(fromParams).trim() !== '') {
        return String(fromParams).trim();
    }
    if (process.env.AIO_DB_IMS_TOKEN != null && String(process.env.AIO_DB_IMS_TOKEN).trim() !== '') {
        return String(process.env.AIO_DB_IMS_TOKEN).trim();
    }
    const fromOAuth = await fetchImsTokenFromClientCredentials(params);
    if (fromOAuth) {
        return fromOAuth;
    }
    let generateAccessTokenFn;
    try {
        ({ generateAccessToken: generateAccessTokenFn } = require('@adobe/aio-lib-core-auth'));
    }
    catch {
        throw new Error('ABDB IMS token missing: set OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_ORG_ID, OAUTH_SCOPES on the action; ' +
            'or pass access_token / options.token; or set AIO_DB_IMS_TOKEN; ' +
            'or install @adobe/aio-lib-core-auth.');
    }
    const tokenResponse = await generateAccessTokenFn(params);
    return tokenResponse.access_token?.token || tokenResponse.access_token || tokenResponse;
}
/**
 * Get ABDB client. Requires a valid IMS access token (see resolveImsToken).
 *
 * @param {object} params - Action params (for generateAccessToken when package is used)
 * @param {object} options - { token?: string, region?: string, ow?: { namespace?: string } }
 * @returns {Promise<{ db: object, client: object, close: () => Promise<void> }>}
 */
async function getClientAbdb(params = {}, options = {}) {
    const token = await resolveImsToken(params, options);
    const region = options.region || process.env.AIO_DB_REGION || 'amer';
    const ow = options.ow;
    const db = await libDb.init({ token, region, ...(ow ? { ow } : {}) });
    const client = await db.connect();
    return {
        db,
        client,
        close: async () => client.close()
    };
}
/**
 * Run work with a connected client; always closes the client in finally.
 *
 * @param {object} params
 * @param {(client: object) => Promise<*>} fn
 * @param {object} [options]
 * @returns {Promise<*>}
 */
async function withDbClient(params, fn, options = {}) {
    const { client, close } = await getClientAbdb(params, options);
    try {
        return await fn(client);
    }
    finally {
        await close();
    }
}
// ——— DbClient (database-level) ———
async function dbStats(client, options = {}) {
    return client.dbStats(options);
}
async function orgStats(client, options = {}) {
    return client.orgStats(options);
}
async function listCollections(client, filter = {}, options = {}) {
    return client.listCollections(filter, options);
}
async function createCollection(client, name, options = {}) {
    return client.createCollection(name, options);
}
// ——— DbCollection: writes ———
async function insertOne(client, collectionName, document, options = {}) {
    return getCollectionByName(client, collectionName).insertOne(document, options);
}
async function insertMany(client, collectionName, documents, options = {}) {
    return getCollectionByName(client, collectionName).insertMany(documents, options);
}
async function updateOne(client, collectionName, filter, update, options = {}) {
    return getCollectionByName(client, collectionName).updateOne(filter, update, options);
}
async function updateMany(client, collectionName, filter, update, options = {}) {
    return getCollectionByName(client, collectionName).updateMany(filter, update, options);
}
async function replaceOne(client, collectionName, filter, replacement, options = {}) {
    return getCollectionByName(client, collectionName).replaceOne(filter, replacement, options);
}
async function deleteOne(client, collectionName, filter, options = {}) {
    return getCollectionByName(client, collectionName).deleteOne(filter, options);
}
async function deleteMany(client, collectionName, filter, options = {}) {
    return getCollectionByName(client, collectionName).deleteMany(filter, options);
}
async function bulkWrite(client, collectionName, operations, options = {}) {
    return getCollectionByName(client, collectionName).bulkWrite(operations, options);
}
async function findOneAndUpdate(client, collectionName, filter, update, options = {}) {
    return getCollectionByName(client, collectionName).findOneAndUpdate(filter, update, options);
}
async function findOneAndReplace(client, collectionName, filter, replacement, options = {}) {
    return getCollectionByName(client, collectionName).findOneAndReplace(filter, replacement, options);
}
async function findOneAndDelete(client, collectionName, filter, options = {}) {
    return getCollectionByName(client, collectionName).findOneAndDelete(filter, options);
}
// ——— DbCollection: reads ———
async function findOne(client, collectionName, filter, options = {}) {
    return getCollectionByName(client, collectionName).findOne(filter, options);
}
/** ABDB findOne throws DbError with message "Document not found" when no match — unlike MongoDB null. */
function isDocumentNotFoundDbError(err) {
    const msg = err != null && typeof err.message === 'string' ? err.message : '';
    return err?.name === 'DbError' && msg.includes('Document not found');
}
/**
 * Like findOne, but returns null when no document matches (ABDB error → null).
 *
 * @returns {Promise<object|null>}
 */
async function findOneOrNull(client, collectionName, filter, options = {}) {
    try {
        return await findOne(client, collectionName, filter, options);
    }
    catch (err) {
        if (isDocumentNotFoundDbError(err)) {
            return null;
        }
        throw err;
    }
}
/**
 * @returns {object} FindCursor — await cursor.close() when done (or call client.close()).
 */
function find(client, collectionName, filter = {}, options = {}) {
    return getCollectionByName(client, collectionName).find(filter, options);
}
async function findArray(client, collectionName, filter = {}, options = {}) {
    return getCollectionByName(client, collectionName).findArray(filter, options);
}
/** find() + toArray() with cursor closed after use. */
async function findToArray(client, collectionName, filter = {}, options = {}) {
    const cursor = find(client, collectionName, filter, options);
    try {
        return await cursor.toArray();
    }
    finally {
        await cursor.close();
    }
}
async function countDocuments(client, collectionName, filter = {}, options = {}) {
    return getCollectionByName(client, collectionName).countDocuments(filter, options);
}
async function estimatedDocumentCount(client, collectionName, options = {}) {
    return getCollectionByName(client, collectionName).estimatedDocumentCount(options);
}
async function distinct(client, collectionName, field, filter = {}, options = {}) {
    return getCollectionByName(client, collectionName).distinct(field, filter, options);
}
// ——— aggregate ———
/**
 * @returns {object} AggregateCursor — close when done.
 */
function aggregate(client, collectionName, pipeline = [], options = {}) {
    return getCollectionByName(client, collectionName).aggregate(pipeline, options);
}
async function aggregateToArray(client, collectionName, pipeline = [], options = {}) {
    const cursor = aggregate(client, collectionName, pipeline, options);
    try {
        return await cursor.toArray();
    }
    finally {
        await cursor.close();
    }
}
// ——— indexes & collection admin ———
async function getIndexes(client, collectionName) {
    return getCollectionByName(client, collectionName).getIndexes();
}
async function createIndex(client, collectionName, specification, options = {}) {
    return getCollectionByName(client, collectionName).createIndex(specification, options);
}
async function dropIndex(client, collectionName, index, options = {}) {
    return getCollectionByName(client, collectionName).dropIndex(index, options);
}
async function collectionStats(client, collectionName, options = {}) {
    return getCollectionByName(client, collectionName).stats(options);
}
async function dropCollection(client, collectionName, options = {}) {
    return getCollectionByName(client, collectionName).drop(options);
}
async function renameCollection(client, collectionName, newCollectionName, options = {}) {
    const col = getCollectionByName(client, collectionName);
    await col.renameCollection(newCollectionName, options);
    return col;
}
module.exports = {
    COLLECTION_IMPORT_QUEUE,
    IMPORT_PIPELINE_COLLECTIONS,
    getClient,
    resetClientCache,
    getCollection,
    ensureImportCollectionsExist,
    resolveImsToken,
    getCollectionByName,
    getClientAbdb,
    withDbClient,
    dbStats,
    orgStats,
    listCollections,
    createCollection,
    insertOne,
    insertMany,
    updateOne,
    updateMany,
    replaceOne,
    deleteOne,
    deleteMany,
    bulkWrite,
    findOneAndUpdate,
    findOneAndReplace,
    findOneAndDelete,
    findOne,
    findOneOrNull,
    find,
    findArray,
    findToArray,
    countDocuments,
    estimatedDocumentCount,
    distinct,
    aggregate,
    aggregateToArray,
    getIndexes,
    createIndex,
    dropIndex,
    collectionStats,
    dropCollection,
    renameCollection
};
