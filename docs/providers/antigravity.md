# Antigravity

> Reverse-engineered from app bundle and language server binary. May change without notice.

Antigravity is built on Codeium/Windsurf-derived infrastructure and uses the same Codeium language server binary and Connect-RPC protocol. The discovery, port probing, and RPC endpoints are virtually identical to that stack. The key differences: Antigravity uses fraction-based quota pools (not credits), and doesn't require an API key in the request metadata.

## Overview

- **Vendor:** Google (internal codename "Jetski")
- **Protocol:** Connect RPC v1 (JSON over HTTP) on local language server
- **Service:** `exa.language_server_pb.LanguageServerService`
- **Auth:** CSRF token from app/IDE process args; Google OAuth tokens from SQLite; `agy` token from macOS Keychain
- **Quota:** fraction (0.0–1.0, where 1.0 = 100% remaining)
- **Quota pools:** all Gemini models share one pool; Claude and other non-Gemini models share a second pool. Each pool has a 5-hour and a weekly window (since 2026-05-19).
- **Timestamps:** ISO 8601
- **Requires:** Antigravity app/IDE running, signed-in app/IDE SQLite credentials, or `agy` signed in

## Discovery

The Antigravity app/IDE language server listens on a random localhost port. OpenUsage needs its port and CSRF token.

### Daemon file (Antigravity 2.35+)

Since 2.35, the token is no longer on the command line. Antigravity writes one file per running server to `~/.gemini/antigravity/daemon/hub_<httpPort>.json`:

```json
{ "pid": 15752, "httpsPort": 61475, "httpPort": 61476, "lsVersion": "2.35.2", "csrfToken": "<token>" }
```

Old files from earlier sessions stay behind, so OpenUsage only uses the file whose `pid` matches the running `language_server` process. It then calls `httpPort` directly, with no port probing.

### Process arguments (older versions)

When no daemon file matches, OpenUsage falls back to reading the token from the process arguments:

```bash
# 1. Find process and extract CSRF token
ps -ax -o pid=,command= | grep -i '[l]anguage_server.*antigravity'
# Process name: language_server, language_server_macos, or language_server_macos_arm
# Match: --app_data_dir antigravity / antigravity-ide OR path contains /antigravity/
# Extract: --csrf_token <token>
# Extract: --extension_server_port <port>  (HTTP fallback)

# 2. Find listening ports
lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>

# 3. Probe each port to find the Connect-RPC endpoint
POST https://127.0.0.1:<port>/.../GetUnleashData  → first 200 OK wins
```

Port and CSRF token change on every app/IDE restart. The LS may use HTTPS with a self-signed cert. Some of the process's other ports belong to different local services and answer `401`; the port probe skips those.

`agy` can also expose the same local service via an `agy` process. It has listening ports but no CSRF token or Antigravity marker flags, so discovery matches the `agy` executable directly.

## Headers (all local requests)

| Header | Required | Value |
|---|---|---|
| Content-Type | yes | `application/json` |
| Connect-Protocol-Version | yes | `1` |
| x-codeium-csrf-token | yes | `<csrf_token>` (from the daemon file or process args) |
| x-antigravity-csrf-token | yes | same token; newer builds document this name |

## What OpenUsage Shows

| Row | Source bucket | Window |
|---|---|---|
| Session | `gemini-5h` | 5 hours |
| Weekly | `gemini-weekly` | 7 days |
| Argon Weekly | the one weekly bucket in the `Gemini 4 Argon` group | 7 days |
| Claude | `3p-5h` | 5 hours |
| Claude Weekly | `3p-weekly` | 7 days |

A row only appears when Google reports a usable value for it. Argon Weekly is skipped when the Argon group is missing, disabled, malformed, or has more than one weekly bucket.

## Endpoints

### RetrieveUserQuotaSummary (primary)

The only endpoint that reports the shared pools and their weekly windows. OpenUsage asks it first on every source.

```
POST http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
```

The request body is the same `metadata` object as `GetUserStatus`. A 404 means the build doesn't have it, and OpenUsage falls back to `GetUserStatus`. The plan name still comes from `GetUserStatus`.

#### Response

The language server wraps the groups in `response`. Cloud Code returns `groups` at the top level.

```jsonc
{
  "response": {
    "groups": [
      {
        "displayName": "Gemini Models",
        "buckets": [
          { "bucketId": "gemini-5h", "remainingFraction": 0.8, "resetTime": "2026-10-27T00:00:00Z" },
          { "bucketId": "gemini-weekly", "remainingFraction": 0.7, "resetTime": "2026-10-30T00:00:00Z", "window": "weekly" }
        ]
      },
      {
        "displayName": "Gemini 4 Argon",
        "buckets": [
          { "bucketId": "gemini-argon-wtu-weekly", "remainingFraction": 1, "window": "weekly" }
        ]
      },
      {
        "displayName": "Claude and GPT models",
        "buckets": [
          { "bucketId": "3p-5h", "remainingFraction": 0.6 },
          { "bucketId": "3p-weekly", "remainingFraction": 0.5, "window": "weekly" }
        ]
      }
    ]
  }
}
```

A parsed summary is the final answer for that source, even when it has no usable buckets. OpenUsage never mixes in the legacy endpoints then, because they report a model with missing quota info as fully used.

### GetUserStatus (legacy fallback, plan name)

Returns plan info and per-model quota for all models (Gemini, Claude, GPT-OSS) in a single call.

```
POST http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetUserStatus
```

#### Request

```json
{
  "metadata": {
    "ideName": "antigravity",
    "extensionName": "antigravity",
    "ideVersion": "unknown",
    "locale": "en"
  }
}
```

#### Response

```jsonc
{
  "userStatus": {
    "planStatus": {
      "planInfo": {
        "planName": "Pro",                       // "Free" | "Pro" | "Teams" | "Ultra"
        "teamsTier": "TEAMS_TIER_PRO"
      }
    },

    "cascadeModelConfigData": {
      "clientModelConfigs": [
        {
          "label": "Gemini 3 Pro (High)",
          "modelOrAlias": { "model": "MODEL_PLACEHOLDER_M7" },
          "quotaInfo": {
            "remainingFraction": 1,              // 0.0–1.0
            "resetTime": "2026-02-07T14:23:01Z"
          }
        },
        {
          "label": "Claude Sonnet 4.5",
          "quotaInfo": { "remainingFraction": 1, "resetTime": "..." }
        },
        {
          "label": "Claude Opus 4.5 (Thinking)",
          "quotaInfo": { "remainingFraction": 1, "resetTime": "..." }
        },
        {
          "label": "GPT-OSS 120B (Medium)",
          "quotaInfo": { "remainingFraction": 1, "resetTime": "..." }
        }
        // ~7 models total, dynamic
      ]
    }
  }
}
```

### GetCommandModelConfigs (fallback)

Returns model configs with per-model quota only. No plan info, no email. Use when `GetUserStatus` fails.

```
POST http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs
```

#### Request

```json
{
  "metadata": {
    "ideName": "antigravity",
    "extensionName": "antigravity",
    "ideVersion": "unknown",
    "locale": "en"
  }
}
```

#### Response

```jsonc
{
  "clientModelConfigs": [
    // same shape as GetUserStatus.cascadeModelConfigData.clientModelConfigs
  ]
}
```

## Available Models

| Display Name | Internal ID | Provider |
|---|---|---|
| Gemini 3 Flash | 1018 | Google |
| Gemini 3 Pro (High) | 1008 | Google |
| Gemini 3 Pro (Low) | 1007 | Google |
| Claude Sonnet 4.5 | 333 | Anthropic (proxied) |
| Claude Sonnet 4.5 (Thinking) | 334 | Anthropic (proxied) |
| Claude Opus 4.6 (Thinking) | MODEL_PLACEHOLDER_M26 | Anthropic (proxied) |
| GPT-OSS 120B (Medium) | 342 | OpenAI (proxied) |

Models are dynamic — the list changes as Google adds/removes them. The legacy fallback reads labels from the response and merges them into two rows: every Gemini model goes into **Session**, everything else into **Claude**. Each row keeps the pool's worst remaining fraction. These endpoints only have the 5-hour window, so the weekly rows are empty on this fallback.

Interestingly, non-Google models (Claude, GPT-OSS) are proxied through Codeium/Windsurf infrastructure — Antigravity uses the same language server binary as Windsurf. The `GetUserStatus` response also includes `monthlyPromptCredits`, `monthlyFlowCredits`, and `monthlyFlexCreditPurchaseAmount` fields inherited from the Windsurf credit system, but these appear to be completely irrelevant to Antigravity's quota model which is purely fraction-based per model.

## Local SQLite Database

The Antigravity IDE stores auth credentials in VS Code-compatible state databases.

- **Paths, tried in order:**
  - `~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb`
  - `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb`
- **Table:** `ItemTable` (`key` TEXT, `value` TEXT)

### antigravityUnifiedStateSync.oauthToken (sentinel envelope → protobuf)

Google OAuth tokens are stored under this key in a double-wrapped base64 envelope.

Decoding layers:

1. Base64-decode the DB `value` → `outer` bytes.
2. `outer` field 1 (wire type 2) → `wrapper` bytes.
3. Inside `wrapper`: field 1 is the sentinel string `"oauthTokenInfoSentinelKey"`; field 2 is `payload` bytes.
4. Inside `payload`: field 1 (wire type 2) is a **UTF-8 base64 string** (not raw bytes).
5. Base64-decode that string → final `OAuthTokenInfo` protobuf.

```protobuf
message OAuthTokenInfo {
  string access_token = 1;              // "ya29...." Google OAuth access token
  string token_type = 2;                // ignored
  string refresh_token = 3;             // "1//..." Google OAuth refresh token
  Timestamp expiry = 4;                 // field 4, wire type 2
}
message Timestamp {
  int64 seconds = 1;                    // Unix epoch seconds
}
```

The plugin decodes this using a minimal protobuf wire-format parser (varint, length-delimited, fixed32, fixed64). The access token is short-lived; the refresh token is used to obtain new access tokens via Google OAuth.

### Token Refresh

```
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
&client_secret=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
&refresh_token=<refresh_token>
&grant_type=refresh_token
```

Response: `{ "access_token": "ya29...", "expires_in": 3599 }`

Same client_id/secret is there in the Antigravity app bundle, used for the Google OAuth refresh token.

## Cloud Code API (fallback)

When the language server is not running, the plugin falls back to Google's Cloud Code API using a Google OAuth access token from the unified-state protobuf, a cached refreshed token, or the `agy` keychain account.

### loadCodeAssist (plan and project)

```
POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
User-Agent: antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=amd64)

{ "metadata": { "ideType": "ANTIGRAVITY", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" } }
```

Production is tried first, then daily. OpenUsage calls it the way the Antigravity app does, because Google leaves out the tier for other callers. It provides:

- `cloudaicompanionProject`: sent with the quota summary. Free accounts get `403 SUBSCRIPTION_REQUIRED` without it.
- The plan: a known `paidTier.id` wins (`g1-pro-tier` → Google AI Pro, `g1-ultra-tier` → Google AI Ultra, `g1-ultra-lite-tier` → Google AI Ultra Lite). Otherwise the tier name is used, shortened to "Google AI Pro/Ultra/Ultra Lite" when it mentions one.

### retrieveUserQuotaSummary

```
POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
User-Agent: antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=amd64)

{ "project": "<cloudaicompanionProject>" }
```

OpenUsage asks the daily host first, because it has the live counters. If daily's answer has all four shared-pool windows, that's used. Otherwise OpenUsage also asks production and combines the two, with daily winning where both report the same window. The `hub` User-Agent is what exposes the Argon quota.

If neither host answers with a summary (for example a 404, or `SUBSCRIPTION_REQUIRED`), OpenUsage falls back to `fetchAvailableModels`. A sign-in rejection counts as an expired token instead, so it triggers the refresh flow rather than the fallback.

### fetchAvailableModels (legacy fallback)

```
POST https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
Authorization: Bearer <access_token>
Content-Type: application/json
User-Agent: antigravity
```

Base URLs tried in order:
1. `https://daily-cloudcode-pa.googleapis.com`
2. `https://cloudcode-pa.googleapis.com`

### agy keychain fallback

`agy` stores its auth in the macOS Keychain under service `gemini`, account `antigravity`. OpenUsage reads that exact account only; it does not use legacy Gemini CLI files.

For `agy`, OpenUsage calls:

1. `POST /v1internal:loadCodeAssist`
2. `POST /v1internal:retrieveUserQuotaSummary` (same as above)
3. `POST /v1internal:retrieveUserQuota` only when there is no summary

#### Response

```jsonc
{
  "models": {
    "gemini-3-pro": {
      "displayName": "Gemini 3 Pro",
      "model": "gemini-3-pro",
      "quotaInfo": {
        "remainingFraction": 0.8,          // 0.0–1.0
        "resetTime": "2026-02-08T10:00:00Z"
      }
    }
    // ... more models
  }
}
```

Returns 401/403 if the token is invalid or expired — triggers reactive refresh.

The response includes all models provisioned for the account. The plugin filters out non-user-facing models using three layers: (1) `isInternal: true` flag from the API, (2) empty `displayName` (catches internal autocomplete models like `chat_20706`, `tab_flash_lite_preview`), and (3) a model-ID blacklist (catches Gemini 2.5 variants and placeholders).

The Cloud Code model set is a superset of the LS model set. The LS returns only cascade-configured chat models, Cloud Code includes all provisioned models. This difference is expected.

## Plugin Strategy

1. Probe the Antigravity app/IDE language server: `RetrieveUserQuotaSummary`, then `GetUserStatus` / `GetCommandModelConfigs` as the fallback.
2. Probe the `agy` local language server the same way.
3. Read SQLite token candidates from both Antigravity state DB paths.
4. Try unexpired SQLite/cached access tokens with `loadCodeAssist` and `retrieveUserQuotaSummary`, falling back to `fetchAvailableModels`.
5. Refresh SQLite refresh tokens only after auth failure or when no access token exists.
6. Read `agy` keychain token from service `gemini`, account `antigravity`, then call `loadCodeAssist` and `retrieveUserQuotaSummary`, falling back to `retrieveUserQuota`.
7. If all strategies fail: error "Start Antigravity or run `agy` and try again."
