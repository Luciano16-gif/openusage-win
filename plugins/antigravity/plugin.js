(function () {
  var LS_SERVICE = "exa.language_server_pb.LanguageServerService"
  var STATE_DBS = [
    "~/Library/Application Support/Antigravity IDE/User/globalStorage/state.vscdb",
    "~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb",
  ]
  var AGY_KEYCHAIN_SERVICE = "gemini"
  var AGY_KEYCHAIN_ACCOUNT = "antigravity"
  var CLOUD_CODE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]
  var LOAD_CODE_ASSIST_PATH = "/v1internal:loadCodeAssist"
  var FETCH_MODELS_PATH = "/v1internal:fetchAvailableModels"
  var RETRIEVE_QUOTA_PATH = "/v1internal:retrieveUserQuota"
  var QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary"
  var QUOTA_SUMMARY_URLS = CLOUD_CODE_URLS
  var LOAD_CODE_ASSIST_URLS = [CLOUD_CODE_URLS[1], CLOUD_CODE_URLS[0]]
  var CLOUD_CODE_CLIENT_UA = "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=amd64)"
  var LOAD_CODE_ASSIST_METADATA = { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }
  var SESSION_PERIOD_MS = 5 * 60 * 60 * 1000
  var WEEK_PERIOD_MS = 7 * 24 * 60 * 60 * 1000
  var SUMMARY_BUCKETS = [
    { id: "gemini-5h", label: "Session", periodMs: SESSION_PERIOD_MS },
    { id: "gemini-weekly", label: "Weekly", periodMs: WEEK_PERIOD_MS },
    { id: "3p-5h", label: "Claude", periodMs: SESSION_PERIOD_MS },
    { id: "3p-weekly", label: "Claude Weekly", periodMs: WEEK_PERIOD_MS },
  ]
  var ARGON_GROUP_NAME = "Gemini 4 Argon"
  var ARGON_WEEKLY_LABEL = "Argon Weekly"
  var PAID_TIER_PLANS = {
    "g1-pro-tier": "Google AI Pro",
    "g1-ultra-tier": "Google AI Ultra",
    "g1-ultra-lite-tier": "Google AI Ultra Lite",
  }
  var LOGIN_MESSAGE = "Start Antigravity or run `agy` and try again."
  var DAEMON_DIR = "~/.gemini/antigravity/daemon"
  var GOOGLE_OAUTH_URL = "https://oauth2.googleapis.com/token"
  var GOOGLE_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
  var GOOGLE_CLIENT_SECRET = "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"
  var OAUTH_TOKEN_KEY = "antigravityUnifiedStateSync.oauthToken"
  var OAUTH_TOKEN_SENTINEL = "oauthTokenInfoSentinelKey"
  var CC_MODEL_BLACKLIST = {
    "MODEL_CHAT_20706": true,
    "MODEL_CHAT_23310": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE": true,
    "MODEL_GOOGLE_GEMINI_2_5_PRO": true,
    "MODEL_PLACEHOLDER_M19": true,
    "MODEL_PLACEHOLDER_M9": true,
    "MODEL_PLACEHOLDER_M12": true,
  }
  // --- Protobuf wire-format decoder ---

  function readVarint(s, pos) {
    var v = 0
    var shift = 0
    while (pos < s.length) {
      var b = s.charCodeAt(pos++)
      v += (b & 0x7f) * Math.pow(2, shift)
      if ((b & 0x80) === 0) return { v: v, p: pos }
      shift += 7
    }
    return null
  }

  function readFields(s) {
    var fields = {}
    var pos = 0
    while (pos < s.length) {
      var tag = readVarint(s, pos)
      if (!tag) break
      pos = tag.p
      var fieldNum = Math.floor(tag.v / 8)
      var wireType = tag.v % 8
      if (wireType === 0) {
        var val = readVarint(s, pos)
        if (!val) break
        fields[fieldNum] = { type: 0, value: val.v }
        pos = val.p
      } else if (wireType === 1) {
        if (pos + 8 > s.length) break
        pos += 8
      } else if (wireType === 2) {
        var len = readVarint(s, pos)
        if (!len) break
        pos = len.p
        if (pos + len.v > s.length) break
        fields[fieldNum] = { type: 2, data: s.substring(pos, pos + len.v) }
        pos += len.v
      } else if (wireType === 5) {
        if (pos + 4 > s.length) break
        pos += 4
      } else {
        break
      }
    }
    return fields
  }

  // --- SQLite credential reading ---

  // Antigravity wraps OAuth state in a double-base64 envelope:
  //   b64(outer.f1 = wrapper{ f1=sentinel, f2=payload{ f1=b64(inner proto) } }).
  // The inner base64 layer is the unusual part — it's a UTF-8 string field, not raw bytes.
  function unwrapOAuthSentinel(ctx, base64Text) {
    var trimmed = String(base64Text || "").replace(/^\s+|\s+$/g, "")
    if (!trimmed) return null
    var outer = ctx.base64.decode(trimmed)
    var outerFields = readFields(outer)
    if (!outerFields[1] || outerFields[1].type !== 2) return null
    var wrapper = readFields(outerFields[1].data)
    var sentinel = (wrapper[1] && wrapper[1].type === 2) ? wrapper[1].data : null
    var payload = (wrapper[2] && wrapper[2].type === 2) ? wrapper[2].data : null
    if (sentinel !== OAUTH_TOKEN_SENTINEL || !payload) return null
    var payloadFields = readFields(payload)
    if (!payloadFields[1] || payloadFields[1].type !== 2) return null
    var innerText = payloadFields[1].data.replace(/^\s+|\s+$/g, "")
    if (!innerText) return null
    return ctx.base64.decode(innerText)
  }

  function loadOAuthTokensFromDb(ctx, dbPath) {
    try {
      var rows = ctx.host.sqlite.query(
        dbPath,
        "SELECT value FROM ItemTable WHERE key = '" + OAUTH_TOKEN_KEY + "' LIMIT 1"
      )
      var parsed = ctx.util.tryParseJson(rows)
      if (!parsed || !parsed.length || !parsed[0].value) return null
      var inner = unwrapOAuthSentinel(ctx, parsed[0].value)
      if (!inner) return null
      var fields = readFields(inner)
      var accessToken = (fields[1] && fields[1].type === 2) ? fields[1].data : null
      var refreshToken = (fields[3] && fields[3].type === 2) ? fields[3].data : null
      var expirySeconds = null
      if (fields[4] && fields[4].type === 2) {
        var ts = readFields(fields[4].data)
        if (ts[1] && ts[1].type === 0) expirySeconds = ts[1].value
      }
      if (!accessToken && !refreshToken) return null
      return { accessToken: accessToken, refreshToken: refreshToken, expirySeconds: expirySeconds }
    } catch (e) {
      ctx.host.log.warn("failed to read unified oauth token from " + dbPath + ": " + String(e))
      return null
    }
  }

  function loadOAuthTokenCandidates(ctx) {
    var candidates = []
    for (var i = 0; i < STATE_DBS.length; i++) {
      var tokens = loadOAuthTokensFromDb(ctx, STATE_DBS[i])
      if (tokens) candidates.push(tokens)
    }
    return candidates
  }

  // --- Google OAuth token refresh ---

  function refreshAccessToken(ctx, refreshTokenValue) {
    if (!refreshTokenValue) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }
    ctx.host.log.info("attempting Google OAuth token refresh")
    try {
      var resp = ctx.host.http.request({
        method: "POST",
        url: GOOGLE_OAUTH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID) +
          "&client_secret=" + encodeURIComponent(GOOGLE_CLIENT_SECRET) +
          "&refresh_token=" + encodeURIComponent(refreshTokenValue) +
          "&grant_type=refresh_token",
        timeoutMs: 15000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("Google OAuth refresh returned status: " + resp.status)
        return null
      }
      var body = ctx.util.tryParseJson(resp.bodyText)
      if (!body || !body.access_token) {
        ctx.host.log.warn("Google OAuth refresh response missing access_token")
        return null
      }
      var expiresIn = (typeof body.expires_in === "number") ? body.expires_in : 3600
      cacheToken(ctx, body.access_token, expiresIn)
      return body.access_token
    } catch (e) {
      ctx.host.log.warn("Google OAuth refresh failed: " + String(e))
      return null
    }
  }

  // --- Token cache ---

  function loadCachedToken(ctx) {
    var path = ctx.app.pluginDataDir + "/auth.json"
    try {
      if (!ctx.host.fs.exists(path)) return null
      var data = ctx.util.tryParseJson(ctx.host.fs.readText(path))
      if (!data || !data.accessToken || !data.expiresAtMs) return null
      if (data.expiresAtMs <= Date.now()) return null
      return data.accessToken
    } catch (e) {
      ctx.host.log.warn("failed to read cached token: " + String(e))
      return null
    }
  }

  function cacheToken(ctx, accessToken, expiresInSeconds) {
    var path = ctx.app.pluginDataDir + "/auth.json"
    try {
      ctx.host.fs.writeText(path, JSON.stringify({
        accessToken: accessToken,
        expiresAtMs: Date.now() + (expiresInSeconds || 3600) * 1000,
      }))
    } catch (e) {
      ctx.host.log.warn("failed to cache refreshed token: " + String(e))
    }
  }

  // --- agy keychain token ---

  function trimString(value) {
    return typeof value === "string" ? value.trim() : ""
  }

  function decodeBase64(ctx, text) {
    try {
      return ctx.base64.decode(text)
    } catch (e) {
      return null
    }
  }

  function unwrapAgyKeychainText(ctx, raw) {
    var text = trimString(raw)
    if (!text) return null
    if (text.indexOf("go-keyring-base64:") === 0) {
      text = trimString(decodeBase64(ctx, text.slice("go-keyring-base64:".length)))
    }
    return text || null
  }

  function extractTokenFromObject(obj) {
    if (!obj || typeof obj !== "object") return null

    var directKeys = [
      "access_token",
      "accessToken",
      "token",
      "id_token",
      "idToken",
      "bearerToken",
      "auth_token",
      "authToken",
    ]
    for (var i = 0; i < directKeys.length; i++) {
      var value = obj[directKeys[i]]
      if (typeof value === "string" && value.trim()) return value.trim()
    }

    var nestedKeys = ["token", "tokens", "oauth", "oauth2", "credentials", "auth"]
    for (var j = 0; j < nestedKeys.length; j++) {
      var nested = extractTokenFromObject(obj[nestedKeys[j]])
      if (nested) return nested
    }

    return null
  }

  function extractAgyAccessToken(ctx, raw) {
    var text = unwrapAgyKeychainText(ctx, raw)
    if (!text) return null

    var parsed = ctx.util.tryParseJson(text)
    if (typeof parsed === "string" && parsed.trim()) return parsed.trim()
    if (parsed) return extractTokenFromObject(parsed)

    if (text.indexOf("Bearer ") === 0) return text.slice("Bearer ".length).trim() || null
    return text
  }

  function loadAgyKeychainToken(ctx) {
    if (!ctx.host.keychain || typeof ctx.host.keychain.readGenericPassword !== "function") {
      return null
    }
    try {
      var raw = ctx.host.keychain.readGenericPassword(AGY_KEYCHAIN_SERVICE, AGY_KEYCHAIN_ACCOUNT)
      return extractAgyAccessToken(ctx, raw)
    } catch (e) {
      ctx.host.log.info("agy keychain read failed: " + String(e))
      return null
    }
  }

  // --- LS discovery ---

  function readDaemonEntry(ctx, pid) {
    var names
    try {
      names = ctx.host.fs.listDir(DAEMON_DIR)
    } catch (e) {
      return null
    }
    for (var i = 0; i < names.length; i++) {
      if (!/^hub_\d+\.json$/.test(names[i])) continue
      var entry = null
      try {
        entry = ctx.util.tryParseJson(ctx.host.fs.readText(DAEMON_DIR + "/" + names[i]))
      } catch (e) {
        ctx.host.log.warn("failed to read Antigravity daemon file " + names[i] + ": " + String(e))
        continue
      }
      if (!entry || entry.pid !== pid) continue
      if (typeof entry.csrfToken !== "string" || !entry.csrfToken || typeof entry.httpPort !== "number") {
        ctx.host.log.warn("Antigravity daemon file " + names[i] + " is missing its token or port")
        continue
      }
      return entry
    }
    return null
  }

  function discoverLs(ctx) {
    var discovery = ctx.host.ls.discover({
      processName: "language_server",
      markers: ["antigravity", "antigravity-ide"],
      csrfFlag: "",
      portFlag: "--extension_server_port",
      extraFlags: ["--csrf_token"],
    })
    if (!discovery) return null

    var daemon = readDaemonEntry(ctx, discovery.pid)
    if (daemon) {
      return {
        pid: discovery.pid,
        csrf: daemon.csrfToken,
        ports: [],
        endpoint: { port: daemon.httpPort, scheme: "http" },
      }
    }

    var csrf = discovery.csrf || (discovery.extra && discovery.extra.csrf_token) || ""
    if (!csrf) {
      ctx.host.log.warn("Antigravity language server found, but no daemon file or CSRF flag for pid " + discovery.pid)
      return null
    }
    discovery.csrf = csrf
    return discovery
  }

  function discoverAgyLs(ctx) {
    return ctx.host.ls.discover({
      processName: "agy",
      markers: [],
      csrfFlag: "",
      portFlag: null,
    })
  }

  function probePort(ctx, scheme, port, csrf) {
    var resp = ctx.host.http.request({
      method: "POST",
      url: scheme + "://127.0.0.1:" + port + "/" + LS_SERVICE + "/GetUnleashData",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
        "x-antigravity-csrf-token": csrf,
      },
      bodyText: JSON.stringify({
        context: {
          properties: {
            devMode: "false",
            extensionVersion: "unknown",
            ide: "antigravity",
            ideVersion: "unknown",
            os: "macos",
          },
        },
      }),
      timeoutMs: 5000,
      dangerouslyIgnoreTls: scheme === "https",
    })
    return !(resp && ctx.util.isAuthStatus(resp.status))
  }

  function findWorkingPort(ctx, discovery) {
    var ports = discovery.ports || []
    for (var i = 0; i < ports.length; i++) {
      var port = ports[i]
      // Try HTTPS first (LS may use self-signed cert), then HTTP
      try { if (probePort(ctx, "https", port, discovery.csrf)) return { port: port, scheme: "https" } } catch (e) { /* ignore */ }
      try { if (probePort(ctx, "http", port, discovery.csrf)) return { port: port, scheme: "http" } } catch (e) { /* ignore */ }
      ctx.host.log.info("port " + port + " probe failed on both schemes")
    }
    if (discovery.extensionPort) return { port: discovery.extensionPort, scheme: "http" }
    return null
  }

  function callLs(ctx, port, scheme, csrf, method, body, opts) {
    var resp = ctx.host.http.request({
      method: "POST",
      url: scheme + "://127.0.0.1:" + port + "/" + LS_SERVICE + "/" + method,
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
        "x-antigravity-csrf-token": csrf,
      },
      bodyText: JSON.stringify(body || {}),
      timeoutMs: 10000,
      dangerouslyIgnoreTls: scheme === "https",
    })
    if (resp.status < 200 || resp.status >= 300) {
      if (!(opts && opts.quietStatus === resp.status)) {
        ctx.host.log.warn("callLs " + method + " returned " + resp.status)
      }
      return null
    }
    return ctx.util.tryParseJson(resp.bodyText)
  }

  // --- Line builders ---

  function normalizeLabel(label) {
    // "Gemini 3 Pro (High)" -> "Gemini 3 Pro"
    return label.replace(/\s*\([^)]*\)\s*$/, "").trim()
  }

  function poolLabel(normalizedLabel) {
    if (normalizedLabel.toLowerCase().indexOf("gemini") !== -1) return "Session"
    // All non-Gemini models (Claude, GPT-OSS, etc.) share a single quota pool
    return "Claude"
  }

  function percentLine(ctx, label, remainingFraction, resetTime, periodMs) {
    var clamped = Math.max(0, Math.min(1, remainingFraction))
    var used = Math.round((1 - clamped) * 100)
    return ctx.line.progress({
      label: label,
      used: used,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: resetTime || undefined,
      periodDurationMs: periodMs,
    })
  }

  function modelLine(ctx, label, remainingFraction, resetTime) {
    return percentLine(ctx, label, remainingFraction, resetTime, SESSION_PERIOD_MS)
  }

  function summaryGroups(data) {
    if (!data || typeof data !== "object") return null
    var groups = data.response && typeof data.response === "object" ? data.response.groups : undefined
    if (groups === undefined || groups === null) groups = data.groups
    return Array.isArray(groups) ? groups : null
  }

  function groupName(group) {
    return group && typeof group.displayName === "string" ? group.displayName : null
  }

  function groupBuckets(group) {
    if (!group || !Array.isArray(group.buckets)) return []
    return group.buckets.filter(function (b) { return b && typeof b === "object" })
  }

  function usableFraction(bucket) {
    return typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)
  }

  function summaryBucketSpec(id) {
    for (var i = 0; i < SUMMARY_BUCKETS.length; i++) {
      if (SUMMARY_BUCKETS[i].id === id) return SUMMARY_BUCKETS[i]
    }
    return null
  }

  function isCompleteSummary(data) {
    var groups = summaryGroups(data)
    if (!groups) return false
    var usable = {}
    for (var i = 0; i < groups.length; i++) {
      if (groupName(groups[i]) === ARGON_GROUP_NAME) continue
      var buckets = groupBuckets(groups[i])
      for (var j = 0; j < buckets.length; j++) {
        if (typeof buckets[j].bucketId === "string" && usableFraction(buckets[j])) usable[buckets[j].bucketId] = true
      }
    }
    for (var k = 0; k < SUMMARY_BUCKETS.length; k++) {
      if (!usable[SUMMARY_BUCKETS[k].id]) return false
    }
    return true
  }

  function argonWeeklyLine(ctx, groups) {
    var buckets = []
    var found = false
    for (var i = 0; i < groups.length; i++) {
      if (groupName(groups[i]) !== ARGON_GROUP_NAME) continue
      found = true
      buckets = buckets.concat(groupBuckets(groups[i]))
    }
    if (!found) return null
    var weekly = []
    for (var j = 0; j < buckets.length; j++) {
      if (buckets[j].window === "weekly") {
        weekly.push(buckets[j])
      } else {
        ctx.host.log.warn("Argon quota has unsupported window '" + String(buckets[j].window) + "'; skipping its bucket")
      }
    }
    var bucket = weekly[0]
    var id = weekly.length === 1 && typeof bucket.bucketId === "string" ? bucket.bucketId : ""
    if (!id || summaryBucketSpec(id)) {
      ctx.host.log.warn("Argon quota group has no unambiguous separate weekly bucket; dropping its line")
      return null
    }
    if (bucket.disabled !== undefined && bucket.disabled !== null && typeof bucket.disabled !== "boolean") {
      ctx.host.log.warn("Argon weekly quota has an unusable disabled flag; dropping its line")
      return null
    }
    if (bucket.disabled === true) return null
    if (!usableFraction(bucket)) {
      ctx.host.log.warn("Argon weekly quota has no usable remainingFraction; dropping its line")
      return null
    }
    return percentLine(ctx, ARGON_WEEKLY_LABEL, bucket.remainingFraction, bucket.resetTime, WEEK_PERIOD_MS)
  }

  function parseQuotaSummaries(ctx, bodies) {
    var groupLists = []
    for (var i = 0; i < bodies.length; i++) {
      var groups = summaryGroups(bodies[i])
      if (groups) {
        groupLists.push(groups)
      } else {
        ctx.host.log.warn("quota summary response has no decodable groups; treating as not-a-summary")
      }
    }
    if (groupLists.length === 0) return null

    var pooled = {}
    for (var g = 0; g < groupLists.length; g++) {
      for (var j = 0; j < groupLists[g].length; j++) {
        var group = groupLists[g][j]
        if (groupName(group) === ARGON_GROUP_NAME) continue
        var buckets = groupBuckets(group)
        for (var k = 0; k < buckets.length; k++) {
          var bucket = buckets[k]
          var id = typeof bucket.bucketId === "string" ? bucket.bucketId : null
          if (!id || !summaryBucketSpec(id)) {
            ctx.host.log.warn("quota summary: skipping unrecognized bucket id '" + (id || "<absent>") + "'")
            continue
          }
          if (pooled[id]) continue
          if (!usableFraction(bucket)) {
            ctx.host.log.warn("quota summary: bucket '" + id + "' has no usable remainingFraction; dropping its line")
            continue
          }
          pooled[id] = bucket
        }
      }
    }

    var lines = []
    var argonIndex = -1
    for (var s = 0; s < SUMMARY_BUCKETS.length; s++) {
      var spec = SUMMARY_BUCKETS[s]
      var entry = pooled[spec.id]
      if (!entry) continue
      if (argonIndex === -1 && spec.id.indexOf("3p-") === 0) argonIndex = lines.length
      lines.push(percentLine(ctx, spec.label, entry.remainingFraction, entry.resetTime, spec.periodMs))
    }
    for (var a = 0; a < groupLists.length; a++) {
      var argon = argonWeeklyLine(ctx, groupLists[a])
      if (!argon) continue
      lines.splice(argonIndex === -1 ? lines.length : argonIndex, 0, argon)
      break
    }
    return lines
  }

  function formatPlan(raw) {
    var trimmed = typeof raw === "string" ? raw.trim() : ""
    if (!trimmed) return null
    var tiers = ["Ultra Lite", "Ultra", "Pro"]
    for (var i = 0; i < tiers.length; i++) {
      if (trimmed.toLowerCase().indexOf(tiers[i].toLowerCase()) !== -1) return "Google AI " + tiers[i]
    }
    return trimmed.split(/\s+/).map(function (word) {
      return word.charAt(0).toUpperCase() + word.slice(1)
    }).join(" ")
  }

  function parseLoadCodeAssistPlan(loadData) {
    var paidTier = loadData && loadData.paidTier
    if (paidTier && PAID_TIER_PLANS[paidTier.id]) return PAID_TIER_PLANS[paidTier.id]
    var currentTier = loadData && loadData.currentTier
    return formatPlan((paidTier && paidTier.name) || (currentTier && currentTier.name))
  }

  function parseProject(loadData) {
    var project = loadData && loadData.cloudaicompanionProject
    return typeof project === "string" && project.trim() ? project.trim() : null
  }

  function buildModelLines(ctx, configs) {
    var deduped = {}
    for (var i = 0; i < configs.length; i++) {
      var c = configs[i]
      var label = (typeof c.label === "string") ? c.label.trim() : ""
      if (!label) continue
      var qi = c.quotaInfo
      var frac = (qi && typeof qi.remainingFraction === "number") ? qi.remainingFraction : 0
      var rtime = (qi && qi.resetTime) || undefined
      var pool = poolLabel(normalizeLabel(label))
      if (!deduped[pool] || frac < deduped[pool].remainingFraction) {
        deduped[pool] = {
          label: pool,
          remainingFraction: frac,
          resetTime: rtime,
        }
      }
    }

    var lines = []
    var order = ["Session", "Claude"]
    for (var i = 0; i < order.length; i++) {
      var m = deduped[order[i]]
      if (m) lines.push(modelLine(ctx, m.label, m.remainingFraction, m.resetTime))
    }
    return lines
  }

  // --- Cloud Code API ---

  function requestCloudCodeJson(ctx, path, token, userAgent, body, bases) {
    var urls = bases || CLOUD_CODE_URLS
    for (var i = 0; i < urls.length; i++) {
      try {
        var resp = ctx.host.http.request({
          method: "POST",
          url: urls[i] + path,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            "User-Agent": userAgent || "antigravity",
          },
          bodyText: JSON.stringify(body || {}),
          timeoutMs: 15000,
        })
        if (!resp || typeof resp.status !== "number" || !Number.isFinite(resp.status)) {
          ctx.host.log.warn("Cloud Code returned invalid response shape (" + urls[i] + ")")
          continue
        }
        if (ctx.util.isAuthStatus(resp.status)) return { _authFailed: true }
        if (resp.status >= 200 && resp.status < 300) {
          var json = ctx.util.tryParseJson(resp.bodyText)
          if (!json || typeof json !== "object") {
            ctx.host.log.warn("Cloud Code returned invalid JSON (" + urls[i] + ")")
            continue
          }
          return json
        }
      } catch (e) {
        ctx.host.log.warn("Cloud Code request failed (" + urls[i] + "): " + String(e))
      }
    }
    return null
  }

  function loadCodeAssist(ctx, token) {
    return requestCloudCodeJson(
      ctx,
      LOAD_CODE_ASSIST_PATH,
      token,
      CLOUD_CODE_CLIENT_UA,
      { metadata: LOAD_CODE_ASSIST_METADATA },
      LOAD_CODE_ASSIST_URLS
    )
  }

  function requiresSubscription(ctx, resp) {
    if (resp.status !== 403) return false
    var body = ctx.util.tryParseJson(resp.bodyText)
    var details = body && body.error && body.error.details
    if (!Array.isArray(details)) return false
    return details.some(function (d) { return d && d.reason === "SUBSCRIPTION_REQUIRED" })
  }

  function fetchQuotaSummary(ctx, token, project) {
    var bodies = []
    var sawAuthFailure = false
    for (var i = 0; i < QUOTA_SUMMARY_URLS.length; i++) {
      var base = QUOTA_SUMMARY_URLS[i]
      var resp
      try {
        resp = ctx.host.http.request({
          method: "POST",
          url: base + QUOTA_SUMMARY_PATH,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            "User-Agent": CLOUD_CODE_CLIENT_UA,
          },
          bodyText: JSON.stringify(project ? { project: project } : {}),
          timeoutMs: 15000,
        })
      } catch (e) {
        ctx.host.log.warn("quota summary request failed (" + base + "): " + String(e))
        continue
      }
      if (!resp || typeof resp.status !== "number" || !Number.isFinite(resp.status)) continue
      if (resp.status >= 200 && resp.status < 300) {
        var json = ctx.util.tryParseJson(resp.bodyText)
        bodies.push(json)
        if (i === 0 && isCompleteSummary(json)) break
        continue
      }
      if (requiresSubscription(ctx, resp)) {
        ctx.host.log.warn("quota summary: Google reports no Antigravity quota subscription (" + base + ", project " + (project ? "set" : "missing") + ")")
        continue
      }
      if (ctx.util.isAuthStatus(resp.status)) {
        sawAuthFailure = true
        continue
      }
      ctx.host.log.warn("quota summary returned " + resp.status + " (" + base + ")")
    }
    if (bodies.length > 0) {
      var lines = parseQuotaSummaries(ctx, bodies)
      if (lines) return { lines: lines }
    }
    if (sawAuthFailure) return { _authFailed: true }
    return null
  }

  function probeCloudCode(ctx, token) {
    var loadData = loadCodeAssist(ctx, token)
    if (loadData && loadData._authFailed) return loadData

    var summary = fetchQuotaSummary(ctx, token, parseProject(loadData))
    if (summary && summary._authFailed) return summary
    if (summary) return { plan: parseLoadCodeAssistPlan(loadData), lines: summary.lines }

    var data = requestCloudCodeJson(ctx, FETCH_MODELS_PATH, token, "antigravity", {})
    if (!data || data._authFailed) return data
    var lines = buildModelLines(ctx, parseCloudCodeModels(data))
    if (lines.length === 0) return null
    return { plan: parseLoadCodeAssistPlan(loadData), lines: lines }
  }

  function parseCloudCodeModels(data) {
    var modelsObj = data && data.models
    if (!modelsObj || typeof modelsObj !== "object") return []
    var keys = Object.keys(modelsObj)
    var configs = []
    for (var i = 0; i < keys.length; i++) {
      var m = modelsObj[keys[i]]
      if (!m || typeof m !== "object") continue
      if (m.isInternal) continue
      var modelId = m.model || keys[i]
      if (CC_MODEL_BLACKLIST[modelId]) continue
      var displayName =
        (typeof m.displayName === "string" && m.displayName.trim()) ||
        (typeof m.label === "string" && m.label.trim()) ||
        ""
      if (!displayName) continue
      var qi = m.quotaInfo
      var frac = (qi && typeof qi.remainingFraction === "number") ? qi.remainingFraction : 0
      var rtime = (qi && qi.resetTime) || undefined
      configs.push({
        label: displayName,
        quotaInfo: { remainingFraction: frac, resetTime: rtime },
      })
    }
    return configs
  }

  function parseAgyQuotaBuckets(data) {
    var buckets = data && data.buckets
    if (!Array.isArray(buckets)) return []
    var configs = []
    for (var i = 0; i < buckets.length; i++) {
      var bucket = buckets[i]
      if (!bucket || typeof bucket !== "object") continue
      var modelId = (typeof bucket.modelId === "string" && bucket.modelId.trim()) || ""
      if (!modelId) continue
      var frac = (typeof bucket.remainingFraction === "number") ? bucket.remainingFraction : 0
      configs.push({
        label: modelId,
        quotaInfo: { remainingFraction: frac, resetTime: bucket.resetTime || undefined },
      })
    }
    return configs
  }

  function probeAgyCloudCode(ctx, token) {
    var loadData = requestCloudCodeJson(ctx, LOAD_CODE_ASSIST_PATH, token, "agy", {})
    if (!loadData || loadData._authFailed) return loadData

    var project = parseProject(loadData)
    var summary = fetchQuotaSummary(ctx, token, project)
    if (summary && summary._authFailed) return summary
    if (summary) return { plan: parseLoadCodeAssistPlan(loadData), lines: summary.lines }

    var quotaData = null
    if (project) {
      quotaData = requestCloudCodeJson(ctx, RETRIEVE_QUOTA_PATH, token, "agy", { project: project })
    }
    if (!quotaData || quotaData._authFailed) {
      quotaData = requestCloudCodeJson(ctx, RETRIEVE_QUOTA_PATH, token, "agy", {})
    }
    if (!quotaData || quotaData._authFailed) return quotaData

    var lines = buildModelLines(ctx, parseAgyQuotaBuckets(quotaData))
    if (lines.length === 0) return null
    return { plan: parseLoadCodeAssistPlan(loadData), lines: lines }
  }

  // --- LS probe ---

  function probeDiscovery(ctx, discovery) {
    if (!discovery) return null

    var found = discovery.endpoint || findWorkingPort(ctx, discovery)
    if (!found) return null

    ctx.host.log.info("using LS at " + found.scheme + "://127.0.0.1:" + found.port)

    var metadata = {
      ideName: "antigravity",
      extensionName: "antigravity",
      ideVersion: "unknown",
      locale: "en",
    }

    var summaryData = null
    try {
      summaryData = callLs(ctx, found.port, found.scheme, discovery.csrf, "RetrieveUserQuotaSummary", { metadata: metadata }, { quietStatus: 404 })
    } catch (e) {
      ctx.host.log.warn("RetrieveUserQuotaSummary threw: " + String(e))
    }

    var data = null
    try {
      data = callLs(ctx, found.port, found.scheme, discovery.csrf, "GetUserStatus", { metadata: metadata })
    } catch (e) {
      ctx.host.log.warn("GetUserStatus threw: " + String(e))
    }
    var hasUserStatus = data && data.userStatus

    var summaryLines = summaryGroups(summaryData) ? parseQuotaSummaries(ctx, [summaryData]) : null
    if (summaryLines) return { plan: hasUserStatus ? readUserStatusPlan(data.userStatus) : null, lines: summaryLines }

    if (!hasUserStatus) {
      ctx.host.log.warn("GetUserStatus failed, trying GetCommandModelConfigs")
      data = callLs(ctx, found.port, found.scheme, discovery.csrf, "GetCommandModelConfigs", { metadata: metadata })
    }

    // Parse model configs
    var configs
    if (hasUserStatus) {
      configs = (data.userStatus.cascadeModelConfigData || {}).clientModelConfigs || []
    } else if (data && data.clientModelConfigs) {
      configs = data.clientModelConfigs
    } else {
      return null
    }

    var filtered = []
    for (var j = 0; j < configs.length; j++) {
      var mid = configs[j].modelOrAlias && configs[j].modelOrAlias.model
      if (mid && CC_MODEL_BLACKLIST[mid]) continue
      filtered.push(configs[j])
    }

    var lines = buildModelLines(ctx, filtered)
    if (lines.length === 0) return null

    return { plan: hasUserStatus ? readUserStatusPlan(data.userStatus) : null, lines: lines }
  }

  function readUserStatusPlan(userStatus) {
    // Prefer userTier.name (Google's own subscription system) over the legacy
    // planInfo.planName field inherited from Windsurf/Codeium, which always
    // returns "Pro" for all paid tiers including Google AI Ultra.
    var ut = userStatus.userTier
    if (ut && typeof ut.name === "string" && ut.name.trim()) return ut.name.trim()
    var pi = (userStatus.planStatus || {}).planInfo || {}
    return typeof pi.planName === "string" && pi.planName.trim() ? pi.planName.trim() : null
  }

  function probeLs(ctx) {
    return probeDiscovery(ctx, discoverLs(ctx))
  }

  function probeAgyLs(ctx) {
    return probeDiscovery(ctx, discoverAgyLs(ctx))
  }

  // --- Probe ---

  function probe(ctx) {
    var lsResult = probeLs(ctx)
    if (lsResult) return lsResult

    var agyLsResult = probeAgyLs(ctx)
    if (agyLsResult) return agyLsResult

    var dbTokenCandidates = loadOAuthTokenCandidates(ctx)

    var tokens = []
    var nowSec = Math.floor(Date.now() / 1000)
    for (var i = 0; i < dbTokenCandidates.length; i++) {
      var dbTokens = dbTokenCandidates[i]
      if (dbTokens.accessToken && (!dbTokens.expirySeconds || dbTokens.expirySeconds > nowSec)) {
        if (tokens.indexOf(dbTokens.accessToken) === -1) tokens.push(dbTokens.accessToken)
      }
    }

    var cached = loadCachedToken(ctx)
    if (cached && tokens.indexOf(cached) === -1) tokens.push(cached)

    var ccData = null
    var sawAuthFailure = false
    for (var i = 0; i < tokens.length; i++) {
      var nextData = probeCloudCode(ctx, tokens[i])
      if (nextData && !nextData._authFailed) {
        ccData = nextData
        break
      }
      if (nextData && nextData._authFailed) sawAuthFailure = true
    }

    // Only refresh on evidence of an auth failure, or when there were no tokens to try.
    // probeCloudCode returns null for transient failures (5xx/timeouts); without this
    // guard a Cloud Code incident would trigger a Google OAuth refresh every probe cycle
    // instead of ~once per token lifetime — risking refresh-token throttling or rotation.
    if (!ccData && (sawAuthFailure || tokens.length === 0)) {
      var refreshTokens = []
      for (var j = 0; j < dbTokenCandidates.length; j++) {
        var refreshToken = dbTokenCandidates[j].refreshToken
        if (refreshToken && refreshTokens.indexOf(refreshToken) === -1) refreshTokens.push(refreshToken)
      }
      for (var k = 0; k < refreshTokens.length; k++) {
        var refreshed = refreshAccessToken(ctx, refreshTokens[k])
        if (!refreshed) continue
        var refreshedData = probeCloudCode(ctx, refreshed)
        if (refreshedData && !refreshedData._authFailed) {
          ccData = refreshedData
          break
        }
        if (refreshedData && refreshedData._authFailed) ccData = refreshedData
      }
    }

    if (!ccData || ccData._authFailed) {
      var agyToken = loadAgyKeychainToken(ctx)
      if (agyToken) {
        var agyResult = probeAgyCloudCode(ctx, agyToken)
        if (agyResult && !agyResult._authFailed) return agyResult
        if (agyResult && agyResult._authFailed) ccData = agyResult
      }
    }

    if (ccData && !ccData._authFailed) return ccData

    throw LOGIN_MESSAGE
  }

  globalThis.__openusage_plugin = { id: "antigravity", probe: probe }
})()
