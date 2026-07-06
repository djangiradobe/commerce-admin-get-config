/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
*/

const { getCommerceOauthClient } = require('./oauth1a')
const {
  isValidPath,
  toStateKey,
  buildInheritanceChain,
  normalizeScope,
  normalizeScopeId
} = require('./system-config-shared')
const { getClient } = require('./abdb-helper')
const { isEncrypted, decrypt } = require('./system-config-crypto')

const COLLECTION = 'system_config_data'
const CACHE_TTL_MS = 5 * 60 * 1000

// Per-lookup result cache.
const cache = new Map() // key: `${scope}:${scopeId}:${path}` → { value, expiresAt }

// Commerce code → numeric id maps. Refreshed at most every CACHE_TTL_MS.
let websiteCodeToId = null     // Map<code, id>
let websiteCodeToIdAt = 0
let storeCodeToId = null       // Map<code, id> + parentWebsiteId
let storeCodeToIdAt = 0

function maybeParseJson (value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value
  try { return JSON.parse(trimmed) } catch { return value }
}

async function tryFindOne (collection, query) {
  try {
    const arr = await collection.find(query).limit(1).toArray()
    return arr && arr.length ? arr[0] : null
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err)
    if (/not found/i.test(msg)) return null
    throw err
  }
}

function pickCommerceCreds (params) {
  return {
    url: params.COMMERCE_BASE_URL || process.env.COMMERCE_BASE_URL,
    consumerKey: params.COMMERCE_CONSUMER_KEY || process.env.COMMERCE_CONSUMER_KEY,
    consumerSecret: params.COMMERCE_CONSUMER_SECRET || process.env.COMMERCE_CONSUMER_SECRET,
    accessToken: params.COMMERCE_ACCESS_TOKEN || process.env.COMMERCE_ACCESS_TOKEN,
    accessTokenSecret: params.COMMERCE_ACCESS_TOKEN_SECRET || process.env.COMMERCE_ACCESS_TOKEN_SECRET
  }
}

async function loadWebsiteCodeMap (params) {
  const now = Date.now()
  if (websiteCodeToId && (now - websiteCodeToIdAt) < CACHE_TTL_MS) return websiteCodeToId

  const creds = pickCommerceCreds(params)
  if (!creds.url) return websiteCodeToId || new Map()

  try {
    const oauth = getCommerceOauthClient(creds, { error: () => {}, info: () => {} })
    const websites = await oauth.get('store/websites')
    const map = new Map()
    if (Array.isArray(websites)) {
      for (const w of websites) {
        if (w && w.code != null && w.id != null) {
          map.set(String(w.code), String(w.id))
        }
      }
    }
    websiteCodeToId = map
    websiteCodeToIdAt = now
    return map
  } catch (_) {
    return websiteCodeToId || new Map()
  }
}

async function loadStoreViewCodeMap (params) {
  const now = Date.now()
  if (storeCodeToId && (now - storeCodeToIdAt) < CACHE_TTL_MS) return storeCodeToId

  const creds = pickCommerceCreds(params)
  if (!creds.url) return storeCodeToId || new Map()

  try {
    const oauth = getCommerceOauthClient(creds, { error: () => {}, info: () => {} })
    const stores = await oauth.get('store/storeViews')
    const map = new Map()
    if (Array.isArray(stores)) {
      for (const s of stores) {
        if (s && s.code != null && s.id != null) {
          map.set(String(s.code), { id: String(s.id), websiteId: s.website_id != null ? String(s.website_id) : null })
        }
      }
    }
    storeCodeToId = map
    storeCodeToIdAt = now
    return map
  } catch (_) {
    return storeCodeToId || new Map()
  }
}

/**
 * Resolve a scope code (e.g. website 'ch', store view 'en_ch') to its numeric
 * id via Commerce REST. Returns null when the code can't be resolved AND no
 * verbatim fallback is wanted.
 */
async function resolveScopeId (scope, code, params) {
  if (!code) return null
  if (scope === 'websites') {
    const map = await loadWebsiteCodeMap(params)
    return map.get(String(code)) || null
  }
  if (scope === 'stores') {
    const map = await loadStoreViewCodeMap(params)
    return map.get(String(code))?.id || null
  }
  return null
}

/**
 * Look up a single config value from ABDB.
 *
 * @param {string} path     `<section>/<group>/<field>` (e.g. 'campaign_general/url/url')
 * @param {object} [params] action params containing OAuth + crypto + Commerce creds.
 *                          Falls back to process.env when omitted.
 * @param {object} [options]
 * @param {string} [options.scope='default']        'default' | 'websites' | 'stores'
 * @param {string} [options.scopeId]                website / store id (numeric string); takes precedence over scopeCode
 * @param {string} [options.scopeCode]              website / store-view CODE — resolved to numeric id via Commerce REST
 * @param {string|number} [options.parentWebsiteId] used when scope='stores' to fall back to the parent website
 * @param {string} [options.parentWebsiteCode]      same as parentWebsiteId but resolved from a website code
 * @param {boolean} [options.fresh]                 bypass the cache
 * @returns {Promise<*|null>}
 */
async function getConfig (path, params: any = {}, options: any = {}) {
  if (!isValidPath(path)) return null

  let scope
  try {
    scope = normalizeScope(options.scope)
  } catch (_) {
    return null
  }

  // 1. Resolve the active scope id (numeric).
  let resolvedScopeId
  if (scope === 'default') {
    resolvedScopeId = '0'
  } else if (options.scopeId != null && options.scopeId !== '') {
    resolvedScopeId = String(options.scopeId)
  } else if (options.scopeCode) {
    const fromCommerce = await resolveScopeId(scope, options.scopeCode, params)
    // If Commerce isn't reachable, fall back to using the code verbatim — the
    // value still gets queried, and the legacy `getSystemConfig` shim writes
    // under the literal code so this keeps working.
    resolvedScopeId = fromCommerce || String(options.scopeCode)
  } else {
    return null
  }

  // 2. Resolve the parent website id for store-scope inheritance.
  let parentWebsiteId = options.parentWebsiteId
  if (parentWebsiteId == null && options.parentWebsiteCode) {
    parentWebsiteId =
      await resolveScopeId('websites', options.parentWebsiteCode, params) ||
      String(options.parentWebsiteCode)
  }
  // Auto-derive parentWebsiteId from the store view itself when not given.
  if (parentWebsiteId == null && scope === 'stores' && options.scopeCode) {
    const sMap = await loadStoreViewCodeMap(params)
    parentWebsiteId = sMap.get(String(options.scopeCode))?.websiteId || undefined
  }

  let normalizedScopeId
  try {
    normalizedScopeId = normalizeScopeId(scope, resolvedScopeId)
  } catch (_) {
    return null
  }

  const cacheKey = `${scope}:${normalizedScopeId}:${path}`
  const now = Date.now()
  if (!options.fresh) {
    const c = cache.get(cacheKey)
    if (c && c.expiresAt > now) return c.value
  }

  let handle
  try {
    handle = await getClient(params)
  } catch (_) {
    return null
  }

  try {
    const collection = await handle.client.collection(COLLECTION)
    const chain = buildInheritanceChain(scope, normalizedScopeId, parentWebsiteId)

    let resolved = null
    for (const link of chain) {
      const id = toStateKey(link.scope, link.scopeId, path)
      const doc = await tryFindOne(collection, { _id: id })
      if (!doc || doc.value === undefined) continue
      let value = doc.value
      if (isEncrypted(value)) {
        try { value = decrypt(value, params) } catch (_) { /* keep raw */ }
      }
      value = maybeParseJson(value)
      resolved = value
      break
    }

    cache.set(cacheKey, { value: resolved, expiresAt: now + CACHE_TTL_MS })
    return resolved
  } finally {
    try { await handle.close() } catch (_) { /* noop */ }
  }
}

/** Clear the entire in-process cache (e.g. after a re-migration). */
function clearAbdbConfigCache () {
  cache.clear()
  websiteCodeToId = null
  storeCodeToId = null
}

module.exports = {
  COLLECTION,
  getConfig,
  clearAbdbConfigCache
}
