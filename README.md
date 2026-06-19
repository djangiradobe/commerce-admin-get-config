# @adobedjangir/commerce-admin-get-config

Read scoped system configuration from **Adobe App Builder Database (ABDB)**.

Provides `getConfig()` with Magento-style scope inheritance (`default` → `websites` → `stores`), AES-256-GCM decryption for sensitive values, and Commerce REST helpers for resolving website/store codes to numeric IDs.

## Install

```bash
npm install @adobedjangir/commerce-admin-get-config
```

Peer dependencies (App Builder runtime):

```bash
npm install @adobe/aio-lib-core-auth @adobe/aio-lib-db @adobe/aio-lib-ims dotenv
```

## Usage

```js
const { getConfig } = require('@adobedjangir/commerce-admin-get-config')

async function main (params) {
  const apiUrl = await getConfig('sync_general/api/url', params, {
    scope: 'websites',
    scopeCode: 'base'
  })
}
```

## API

| Export | Description |
|--------|-------------|
| `getConfig(path, params, options)` | Read a config value with scope inheritance |
| `clearAbdbConfigCache()` | Clear the in-process lookup cache |

Subpath exports: `./abdb`, `./config`, `./crypto`, `./shared`, `./oauth1a`

## License

Apache-2.0
