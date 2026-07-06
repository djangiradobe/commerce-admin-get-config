"use strict";
/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
*/
Object.defineProperty(exports, "__esModule", { value: true });
// Mirrors Magento's core_config_data: (scope, scope_id, path, value).
// aio-lib-state keys allow [a-zA-Z0-9_-] only, so we encode
//   scope=`default` scopeId=0  path=`web/secure/base_url`
// as the state key
//   sysconfig__default__0__web__secure__base_url
const STATE_KEY_PREFIX = 'sysconfig__';
const SCOPES = ['default', 'websites', 'stores'];
const PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;
const SCOPE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SENSITIVE_PLACEHOLDER = '__SENSITIVE_UNCHANGED__';
const USE_DEFAULT_SENTINEL = '__USE_DEFAULT__';
function isValidPath(path) {
    if (typeof path !== 'string')
        return false;
    const parts = path.split('/');
    if (parts.length !== 3)
        return false;
    return parts.every((p) => PATH_SEGMENT.test(p));
}
function normalizeScope(scope) {
    if (!scope)
        return 'default';
    if (!SCOPES.includes(scope)) {
        throw new Error(`Invalid scope "${scope}". Expected one of: ${SCOPES.join(', ')}`);
    }
    return scope;
}
function normalizeScopeId(scope, scopeId) {
    if (scope === 'default')
        return '0';
    const id = String(scopeId ?? '').trim();
    if (!id || !SCOPE_ID_RE.test(id)) {
        throw new Error(`Invalid scopeId "${scopeId}" for scope "${scope}"`);
    }
    return id;
}
function toStateKey(scope, scopeId, path) {
    if (!isValidPath(path)) {
        throw new Error(`Invalid config path: ${path}`);
    }
    const s = normalizeScope(scope);
    const sid = normalizeScopeId(s, scopeId);
    return [STATE_KEY_PREFIX, s, '__', sid, '__', path.split('/').join('__')].join('');
}
/**
 * Magento-style fallback chain. When reading at store scope we look up:
 *   stores:<storeId>  →  websites:<websiteId>  →  default:0
 * `parentWebsiteId` is supplied by the caller (resolved from /rest/V1/store/storeViews).
 */
function buildInheritanceChain(scope, scopeId, parentWebsiteId) {
    const s = normalizeScope(scope);
    if (s === 'default') {
        return [{ scope: 'default', scopeId: '0' }];
    }
    if (s === 'websites') {
        return [
            { scope: 'websites', scopeId: normalizeScopeId('websites', scopeId) },
            { scope: 'default', scopeId: '0' }
        ];
    }
    // stores
    const chain = [{ scope: 'stores', scopeId: normalizeScopeId('stores', scopeId) }];
    if (parentWebsiteId !== undefined && parentWebsiteId !== null && String(parentWebsiteId) !== '') {
        chain.push({ scope: 'websites', scopeId: normalizeScopeId('websites', parentWebsiteId) });
    }
    chain.push({ scope: 'default', scopeId: '0' });
    return chain;
}
module.exports = {
    STATE_KEY_PREFIX,
    SCOPES,
    SENSITIVE_PLACEHOLDER,
    USE_DEFAULT_SENTINEL,
    isValidPath,
    normalizeScope,
    normalizeScopeId,
    toStateKey,
    buildInheritanceChain
};
