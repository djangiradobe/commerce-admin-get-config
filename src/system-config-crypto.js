/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0
*/

// Equivalent of Magento's env.php `crypt.key`: a project-wide secret used to
// derive an AES-256-GCM key that protects sensitive system_config values at
// rest in App Builder DB (aio-lib-state).
//
// Key material is taken from action params/env (never from request payload):
//   SYSTEM_CONFIG_CRYPT_KEY   – preferred, dedicated secret
//   OAUTH_CLIENT_SECRET       – fallback, the workspace's client secret
//
// Wire format for ciphertext (string):
//   enc:v1:<base64url(salt)>:<base64url(iv)>:<base64url(tag)>:<base64url(ct)>
// `v1` lets us rotate the algorithm later without breaking previously stored
// values. `salt` is per-record so the derived key changes even if the same
// master secret is reused across records.

const crypto = require('crypto')

const ENC_PREFIX = 'enc:v1:'
const KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }

function b64uEncode (buf) {
  return Buffer.from(buf).toString('base64url')
}

function b64uDecode (str) {
  return Buffer.from(str, 'base64url')
}

function resolveMasterSecret (params = {}) {
  const secret =
    params.SYSTEM_CONFIG_CRYPT_KEY ||
    params.OAUTH_CLIENT_SECRET ||
    process.env.SYSTEM_CONFIG_CRYPT_KEY ||
    process.env.OAUTH_CLIENT_SECRET ||
    ''
  if (!secret || typeof secret !== 'string' || secret.length < 8) {
    throw new Error(
      'Encryption key not configured: set SYSTEM_CONFIG_CRYPT_KEY or OAUTH_CLIENT_SECRET'
    )
  }
  return secret
}

function deriveKey (masterSecret, salt) {
  return crypto.scryptSync(masterSecret, salt, KEY_BYTES, SCRYPT_PARAMS)
}

function isEncrypted (value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX)
}

function encrypt (plaintext, params) {
  if (plaintext == null || plaintext === '') {
    return plaintext
  }
  const text = typeof plaintext === 'string' ? plaintext : String(plaintext)
  const secret = resolveMasterSecret(params)
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const key = deriveKey(secret, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    ENC_PREFIX,
    b64uEncode(salt),
    ':',
    b64uEncode(iv),
    ':',
    b64uEncode(tag),
    ':',
    b64uEncode(ct)
  ].join('')
}

function decrypt (encrypted, params) {
  if (!isEncrypted(encrypted)) {
    return encrypted
  }
  const body = encrypted.slice(ENC_PREFIX.length)
  const parts = body.split(':')
  if (parts.length !== 4) {
    throw new Error('Malformed encrypted value')
  }
  const [saltB64, ivB64, tagB64, ctB64] = parts
  const secret = resolveMasterSecret(params)
  const salt = b64uDecode(saltB64)
  const iv = b64uDecode(ivB64)
  const tag = b64uDecode(tagB64)
  const ct = b64uDecode(ctB64)
  const key = deriveKey(secret, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

module.exports = {
  ENC_PREFIX,
  isEncrypted,
  encrypt,
  decrypt,
  resolveMasterSecret
}
