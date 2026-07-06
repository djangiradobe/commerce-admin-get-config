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
const Oauth1a = require('oauth-1.0a');
const crypto = require('crypto');
const got = require('got');
function getOauthClient(options, logger) {
    const instance = {};
    // Remove trailing slash if any
    const serverUrl = options.url;
    const apiVersion = options.version;
    const oauth = Oauth1a({
        consumer: {
            key: options.consumerKey,
            secret: options.consumerSecret
        },
        signature_method: 'HMAC-SHA256',
        hash_function: hashFunctionSha256
    });
    const token = {
        key: options.accessToken,
        secret: options.accessTokenSecret
    };
    const storeCode = options.storeCode || 'default';
    function hashFunctionSha256(baseString, key) {
        return crypto.createHmac('sha256', key).update(baseString).digest('base64');
    }
    async function apiCall(requestData, requestToken = '', customHeaders = {}) {
        try {
            const headers = {
                ...(requestToken
                    ? { Authorization: 'Bearer ' + requestToken }
                    : oauth.toHeader(oauth.authorize(requestData, token))),
                ...customHeaders
            };
            // Configure HTTPS options based on environment
            const httpsOptions = {
                method: requestData.method,
                headers,
                body: requestData.body,
                responseType: 'json',
            };
            return await got(requestData.url, httpsOptions).json();
        }
        catch (error) {
            logger.error(error);
            throw error;
        }
    }
    instance.consumerToken = async function (loginData) {
        return apiCall({
            url: createUrl('integration/customer/token', storeCode),
            method: 'POST',
            body: loginData
        });
    };
    function createUrl(resourceUrl, store) {
        const s = (store != null && String(store).trim()) ? String(store).trim() : storeCode;
        return serverUrl + s + '/' + apiVersion + '/' + resourceUrl;
    }
    instance.get = async function (resourceUrl, requestToken = '', customHeaders = {}) {
        const requestData = {
            url: createUrl(resourceUrl, storeCode),
            method: 'GET'
        };
        return apiCall(requestData, requestToken, customHeaders);
    };
    instance.post = async function (resourceUrl, data, requestToken = '', customHeaders = {}) {
        const requestData = {
            url: createUrl(resourceUrl, storeCode),
            method: 'POST',
            body: data
        };
        return apiCall(requestData, requestToken, customHeaders);
    };
    instance.put = async function (resourceUrl, data, requestToken = '', customHeaders = {}) {
        const requestData = {
            url: createUrl(resourceUrl, storeCode),
            method: 'PUT',
            body: data
        };
        return apiCall(requestData, requestToken, customHeaders);
    };
    instance.delete = async function (resourceUrl, requestToken = '', customHeaders = {}) {
        const requestData = {
            url: createUrl(resourceUrl, storeCode),
            method: 'DELETE'
        };
        return apiCall(requestData, requestToken, customHeaders);
    };
    instance.deleteWithBody = async function (resourceUrl, data, requestToken = '', customHeaders = {}) {
        const requestData = {
            url: createUrl(resourceUrl, storeCode),
            method: 'DELETE',
            body: data
        };
        return apiCall(requestData, requestToken, customHeaders);
    };
    return instance;
}
function getCommerceOauthClient(options, logger) {
    options.version = 'V1';
    const storePrefix = options.storeCode ? `${options.storeCode}/` : '';
    options.url = options.url + 'rest/' + storePrefix;
    return getOauthClient(options, logger);
}
module.exports = {
    getOauthClient,
    getCommerceOauthClient
};
