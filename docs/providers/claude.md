# Claude Code

> Reverse-engineered, undocumented API. May change without notice.

## Overview

- **Protocol:** REST (plain JSON)
- **Base URL:** `https://api.anthropic.com`
- **Auth provider:** `platform.claude.com` (OAuth 2.0)
- **Client ID:** `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- **Beta header required:** `anthropic-beta: oauth-2025-04-20`
- **Utilization:** integer percentage (0-100)
- **Credits:** cents (divide by 100 for dollars)
- **Timestamps:** ISO 8601 (response), unix milliseconds (credentials file)

## Endpoints

### GET /api/oauth/usage

Returns rate limit windows and optional extra credits.

#### Headers

| Header | Required | Value |
|---|---|---|
| Authorization | yes | `Bearer <access_token>` |
| Accept | yes | `application/json` |
| Content-Type | yes | `application/json` |
| anthropic-beta | yes | `oauth-2025-04-20` |

#### Response

```jsonc
{
  "five_hour": {
    "utilization": 25,              // % used in 5h rolling window
    "resets_at": "2026-01-28T15:00:00Z"
  },
  "seven_day": {
    "utilization": 40,              // % used in 7-day window
    "resets_at": "2026-02-01T00:00:00Z"
  },
  "seven_day_sonnet": null,         // legacy per-model weekly windows, now always null
  "seven_day_opus": null,
  "seven_day_omelette": {           // separate weekly Claude Design limit (optional, plan-dependent)
    "utilization": 0,
    "resets_at": "2026-02-01T00:00:00Z"
  },
  "extra_usage": {                  // on-demand overage credits (optional)
    "is_enabled": true,
    "used_credits": 500,            // cents spent
    "monthly_limit": 10000,         // cents cap (0 = unlimited)
    "currency": "USD"
  },
  "limits": [                       // every active limit, including per-model weekly ones
    { "kind": "session", "percent": 25, "resets_at": "...", "scope": null },
    { "kind": "weekly_all", "percent": 40, "resets_at": "...", "scope": null },
    {
      "kind": "weekly_scoped",      // separate weekly limit for one model
      "percent": 5,
      "resets_at": "2026-02-01T00:00:00Z",
      "scope": { "model": { "display_name": "Fable" } }
    }
  ]
}
```

All windows are enforced simultaneously — hitting any limit throttles the user.

Per-model weekly limits moved from the `seven_day_<model>` fields into `limits`. OpenUsage shows the `weekly_scoped` entry for Fable as the **Fable** line.

### GET /api/oauth/profile

Returns the account's current plan. Same headers as `/api/oauth/usage`.

```jsonc
{
  "organization": {
    "organization_type": "claude_max",       // claude_pro, claude_max, claude_team, claude_enterprise, ...
    "rate_limit_tier": "default_claude_max_5x"
  }
}
```

Claude Code saves `subscriptionType` and `rateLimitTier` in its login once and never updates them, so after an upgrade they still show the old plan. OpenUsage reads the plan badge from this endpoint instead, at most once an hour and only after a successful usage request. If the lookup fails, it keeps the last plan it knew, falling back to the plan saved in the login.

Plan names follow Anthropic's Oct 30, 2026 rename: Max 5x shows as **Max** and Max 20x as **Ultra**. Other plans keep a tier suffix when there is one (for example **Team 5x**).

## Authentication

### Token Location

On macOS, OpenUsage reads Claude Code credentials from Keychain first. The default service name is:

```text
Claude Code-credentials
```

When `CLAUDE_CONFIG_DIR` is set, Claude Code may use a config-specific service name instead. OpenUsage checks this hashed name before the default service:

```text
Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR).slice(0, 8)>
```

Keychain values use the same JSON structure as the legacy credentials file:

```jsonc
{
  "claudeAiOauth": {
    "accessToken": "<jwt>",          // OAuth access token (Bearer)
    "refreshToken": "<token>",
    "expiresAt": 1738300000000,      // unix ms
    "scopes": ["..."],
    "subscriptionType": "pro",
    "rateLimitTier": "..."
  }
}
```

**Fallback:** `~/.claude/.credentials.json`. This file can be left behind by older Claude Code versions, so it is treated as a fallback when Keychain does not contain usable credentials.

### Token Refresh

Access tokens are short-lived JWTs. Refreshed proactively 5 minutes before expiration, or reactively on 401/403.

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
```

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "<refresh_token>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

```jsonc
{
  "access_token": "<new_jwt>",
  "refresh_token": "<new_refresh_token>",  // may be same as previous
  "expires_in": 3600                       // seconds
}
```
