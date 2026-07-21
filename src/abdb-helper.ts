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

// The generic ABDB toolkit now lives in the standalone @adobedjangir/abdb
// package. Re-export all of it here (a bare-package `export *` resolves under
// moduleResolution:node, so consumers of
// `@adobedjangir/commerce-admin-get-config/abdb` keep their types), and add the
// app-specific import-pipeline helpers on top.
export * from '@adobedjangir/abdb'

/** Collection this app's import pipeline stages rows into. */
const COLLECTION_IMPORT_QUEUE = 'import_queue'
const IMPORT_PIPELINE_COLLECTIONS = [COLLECTION_IMPORT_QUEUE]

/** Normalize a listCollections() response into a Set of collection names. */
function collectionNamesFromListResponse (raw: any): Set<string> {
  const out = new Set<string>()
  if (!raw) return out
  const visit = (item: any) => {
    if (typeof item === 'string') { out.add(item); return }
    if (item && typeof item === 'object') {
      const n = item.name ?? item.collectionName
      if (typeof n === 'string') out.add(n)
    }
  }
  if (Array.isArray(raw)) { raw.forEach(visit); return out }
  if (typeof raw === 'object') {
    const nested = raw.collections ?? raw.cursor?.firstBatch ?? raw.data
    if (Array.isArray(nested)) nested.forEach(visit)
  }
  return out
}

/**
 * Ensure the import-pipeline collections exist (recreate if dropped in the
 * console). Uses listCollections when available; falls back to createCollection
 * with duplicate tolerance. Best-effort — throws only on unexpected errors.
 */
async function ensureImportCollectionsExist (client: any, options: any = {}): Promise<void> {
  const log = options.logger || { info: () => {}, warn: () => {} }
  let existing = new Set<string>()
  try {
    const raw = await client.listCollections({})
    existing = collectionNamesFromListResponse(raw)
  } catch (e: any) {
    log.warn(`ensureImportCollectionsExist: listCollections failed (${e.message}); attempting createCollection for each pipeline collection`)
  }
  const created: string[] = []
  for (const name of IMPORT_PIPELINE_COLLECTIONS) {
    if (existing.has(name)) continue
    try {
      await client.createCollection(name)
      created.push(name)
    } catch (err: any) {
      const m = (err && err.message) ? String(err.message) : String(err)
      if (/exist|already|duplicate/i.test(m)) continue
      throw err
    }
  }
  if (created.length) log.info(`ensureImportCollectionsExist: created ABDB collections: ${created.join(', ')}`)
}

export { COLLECTION_IMPORT_QUEUE, IMPORT_PIPELINE_COLLECTIONS, ensureImportCollectionsExist }
