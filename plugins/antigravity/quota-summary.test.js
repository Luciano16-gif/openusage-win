import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const DAILY = "https://daily-cloudcode-pa.googleapis.com"
const PROD = "https://cloudcode-pa.googleapis.com"
const SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary"
const LOAD_PATH = "/v1internal:loadCodeAssist"
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_MS = 5 * 60 * 60 * 1000

function bucket(bucketId, remainingFraction, extra) {
  return Object.assign({ bucketId, remainingFraction, resetTime: "2026-12-01T00:00:00Z" }, extra)
}

function summary(groups) {
  return { groups }
}

function fullSummary() {
  return summary([
    { displayName: "Gemini Models", buckets: [bucket("gemini-5h", 0.8), bucket("gemini-weekly", 0.7, { window: "weekly" })] },
    { displayName: "Claude and GPT models", buckets: [bucket("3p-5h", 0.6), bucket("3p-weekly", 0.5, { window: "weekly" })] },
  ])
}

function json(status, body) {
  return { status, bodyText: body === undefined ? "" : JSON.stringify(body) }
}

function useCachedToken(ctx, token) {
  ctx.host.ls.discover.mockReturnValue(null)
  ctx.host.fs.writeText(ctx.app.pluginDataDir + "/auth.json", JSON.stringify({
    accessToken: token || "ya29.cached",
    expiresAtMs: Date.now() + 3600000,
  }))
}

function routeCloud(ctx, routes) {
  const calls = []
  ctx.host.http.request.mockImplementation((opts) => {
    const url = String(opts.url)
    calls.push({ url, body: opts.bodyText ? JSON.parse(opts.bodyText) : null, userAgent: opts.headers["User-Agent"] })
    const handler = routes[url]
    if (handler) return typeof handler === "function" ? handler(opts) : handler
    return json(500)
  })
  return calls
}

function labelsAndUsed(result) {
  return result.lines.map((l) => [l.label, l.used])
}

describe("antigravity quota summary", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("reads pool and weekly quotas from the language server, with the plan from GetUserStatus", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue({ pid: 1, csrf: "csrf", ports: [42001], extensionPort: null })
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.endsWith("/RetrieveUserQuotaSummary")) return json(200, { response: fullSummary() })
      if (url.endsWith("/GetUserStatus")) return json(200, { userStatus: { userTier: { name: "Google AI Ultra" } } })
      return json(200, {})
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(result.plan).toBe("Google AI Ultra")
    expect(labelsAndUsed(result)).toEqual([["Session", 20], ["Weekly", 30], ["Claude", 40], ["Claude Weekly", 50]])
    expect(result.lines.map((l) => l.periodDurationMs)).toEqual([SESSION_MS, WEEK_MS, SESSION_MS, WEEK_MS])
    expect(result.lines[1].resetsAt).toBe("2026-12-01T00:00:00Z")
  })

  it("uses the daemon file of the running language server when the CSRF flag is gone (2.35+)", async () => {
    const ctx = makeCtx()
    const daemonDir = "~/.gemini/antigravity/daemon"
    ctx.host.fs.writeText(daemonDir + "/hub_51170.json", JSON.stringify({ pid: 50880, httpsPort: 51169, httpPort: 51170, csrfToken: "stale" }))
    ctx.host.fs.writeText(daemonDir + "/hub_61476.json", JSON.stringify({ pid: 15752, httpsPort: 61475, httpPort: 61476, csrfToken: "live" }))
    ctx.host.fs.writeText(daemonDir + "/notes.txt", "ignore me")
    ctx.host.ls.discover.mockImplementation((opts) =>
      opts.processName === "language_server" ? { pid: 15752, csrf: "", ports: [65198, 61494, 61476, 61475], extra: {}, extensionPort: null } : null
    )
    const calls = []
    ctx.host.http.request.mockImplementation((opts) => {
      calls.push({ url: String(opts.url), headers: opts.headers })
      if (opts.headers["x-antigravity-csrf-token"] !== "live" || opts.headers["x-codeium-csrf-token"] !== "live") return json(401)
      if (String(opts.url).endsWith("/RetrieveUserQuotaSummary")) return json(200, { response: fullSummary() })
      return json(200, {})
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(result.lines.map((l) => l.label)).toEqual(["Session", "Weekly", "Claude", "Claude Weekly"])
    expect(calls.every((c) => c.url.indexOf("http://127.0.0.1:61476/") === 0)).toBe(true)
    expect(calls.some((c) => c.url.endsWith("/GetUnleashData"))).toBe(false)
  })

  it("falls back to the command-line CSRF token when no daemon file matches", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockImplementation((opts) =>
      opts.processName === "language_server" ? { pid: 1, csrf: "", ports: [42001], extra: { csrf_token: "flag-token" }, extensionPort: null } : null
    )
    ctx.host.http.request.mockImplementation((opts) => {
      if (opts.headers["x-codeium-csrf-token"] !== "flag-token") return json(401)
      if (String(opts.url).endsWith("/RetrieveUserQuotaSummary")) return json(200, { response: fullSummary() })
      return json(200, {})
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(result.lines.map((l) => l.label)).toEqual(["Session", "Weekly", "Claude", "Claude Weekly"])
  })

  it("does not call a language server it has no token for", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockImplementation((opts) =>
      opts.processName === "language_server" ? { pid: 1, csrf: "", ports: [42001], extra: {}, extensionPort: null } : null
    )

    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Start Antigravity or run `agy` and try again.")
    expect(ctx.host.http.request).not.toHaveBeenCalled()
  })

  it("skips local ports that reject the CSRF token and uses the language server port", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue({ pid: 1, csrf: "csrf", ports: [62402, 51170], extensionPort: null })
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.indexOf("https://") === 0) throw new Error("connection failed")
      if (url.includes(":62402/")) return { status: 401, bodyText: "unauthorized" }
      if (url.endsWith("/RetrieveUserQuotaSummary")) return json(200, { response: fullSummary() })
      return json(200, {})
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(result.lines.map((l) => l.label)).toEqual(["Session", "Weekly", "Claude", "Claude Weekly"])
  })

  it("falls back to the per-model language server quota when the summary RPC is missing", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue({ pid: 1, csrf: "csrf", ports: [42001], extensionPort: null })
    ctx.host.http.request.mockImplementation((opts) => {
      const url = String(opts.url)
      if (url.endsWith("/RetrieveUserQuotaSummary")) return json(404)
      if (url.endsWith("/GetUserStatus")) {
        return json(200, {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { label: "Gemini 3.1 Pro (High)", quotaInfo: { remainingFraction: 0.9 } },
                { label: "Gemini 3 Flash", quotaInfo: { remainingFraction: 0.4 } },
                { label: "Claude Sonnet 4.6", quotaInfo: { remainingFraction: 0.5 } },
              ],
            },
          },
        })
      }
      return json(200, {})
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(labelsAndUsed(result)).toEqual([["Session", 60], ["Claude", 50]])
    expect(ctx.host.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("RetrieveUserQuotaSummary returned 404"))
  })

  it("names the project and reads the plan like the Antigravity app, stopping when daily is complete", async () => {
    const ctx = makeCtx()
    useCachedToken(ctx)
    const calls = routeCloud(ctx, {
      [PROD + LOAD_PATH]: json(200, { cloudaicompanionProject: "proj-1", paidTier: { id: "g1-ultra-tier", name: "fake" } }),
      [DAILY + SUMMARY_PATH]: json(200, fullSummary()),
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(calls.map((c) => c.url)).toEqual([PROD + LOAD_PATH, DAILY + SUMMARY_PATH])
    expect(calls[0].body).toEqual({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } })
    expect(calls[1].body).toEqual({ project: "proj-1" })
    expect(calls.every((c) => c.userAgent.indexOf("antigravity/hub/") === 0)).toBe(true)
    expect(result.plan).toBe("Google AI Ultra")
    expect(labelsAndUsed(result)).toEqual([["Session", 20], ["Weekly", 30], ["Claude", 40], ["Claude Weekly", 50]])
  })

  it("fills buckets daily leaves out from production, keeping the first usable value per bucket", async () => {
    const ctx = makeCtx()
    useCachedToken(ctx)
    routeCloud(ctx, {
      [DAILY + SUMMARY_PATH]: json(200, summary([
        { buckets: [bucket("gemini-5h", null), bucket("3p-5h", 0.5), bucket("3p-weekly", 0.9)] },
      ])),
      [PROD + SUMMARY_PATH]: json(200, summary([
        { buckets: [bucket("gemini-5h", 0.75), bucket("gemini-weekly", 0.25), bucket("3p-5h", 0.1)] },
      ])),
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(result.plan).toBeNull()
    expect(labelsAndUsed(result)).toEqual([["Session", 25], ["Weekly", 75], ["Claude", 50], ["Claude Weekly", 10]])
  })

  it("adds a separate Argon weekly row ahead of the Claude pool", async () => {
    const ctx = makeCtx()
    useCachedToken(ctx)
    const body = fullSummary()
    body.groups.unshift({
      displayName: "Gemini 4 Argon",
      buckets: [
        bucket("gemini-argon-5h", 0, { window: "5h" }),
        bucket("gemini-argon-wtu-weekly", 0.6, { window: "weekly" }),
      ],
    })
    routeCloud(ctx, { [DAILY + SUMMARY_PATH]: json(200, body) })

    const result = (await loadPlugin()).probe(ctx)

    expect(labelsAndUsed(result)).toEqual([
      ["Session", 20], ["Weekly", 30], ["Argon Weekly", 40], ["Claude", 40], ["Claude Weekly", 50],
    ])
    expect(result.lines[2].periodDurationMs).toBe(WEEK_MS)
  })

  it("drops an Argon row that is ambiguous, disabled, or malformed but keeps the shared pools", async () => {
    const argonCases = [
      [bucket("a", 0.9, { window: "weekly" }), bucket("b", 0.1, { window: "weekly" })],
      [bucket("a", 0.5, { window: "weekly", disabled: true })],
      [bucket("a", 0.5, { window: "weekly", disabled: "false" })],
      [bucket("gemini-weekly", 0.5, { window: "weekly" })],
      [bucket("a", null, { window: "weekly" })],
    ]
    for (const buckets of argonCases) {
      delete globalThis.__openusage_plugin
      vi.resetModules()
      const ctx = makeCtx()
      useCachedToken(ctx)
      const body = fullSummary()
      body.groups.push({ displayName: "Gemini 4 Argon", buckets })
      routeCloud(ctx, { [DAILY + SUMMARY_PATH]: json(200, body) })

      const result = (await loadPlugin()).probe(ctx)

      expect(result.lines.map((l) => l.label)).toEqual(["Session", "Weekly", "Claude", "Claude Weekly"])
    }
  })

  it("treats a parsed summary as authoritative even when it has no usable buckets", async () => {
    const ctx = makeCtx()
    useCachedToken(ctx)
    const calls = routeCloud(ctx, {
      [DAILY + SUMMARY_PATH]: json(200, summary([{ buckets: [bucket("unknown-bucket", 0.5)] }])),
      [PROD + SUMMARY_PATH]: json(200, summary([])),
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(result.lines).toEqual([])
    expect(calls.some((c) => c.url.includes("fetchAvailableModels"))).toBe(false)
  })

  it("falls back to per-model Cloud Code quota when Google requires a subscription", async () => {
    const ctx = makeCtx()
    useCachedToken(ctx)
    const forbidden = json(403, { error: { code: 403, details: [{ reason: "SUBSCRIPTION_REQUIRED" }] } })
    routeCloud(ctx, {
      [DAILY + SUMMARY_PATH]: forbidden,
      [PROD + SUMMARY_PATH]: forbidden,
      [DAILY + "/v1internal:fetchAvailableModels"]: json(200, {
        models: { "gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.4 } } },
      }),
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(labelsAndUsed(result)).toEqual([["Session", 60]])
  })

  it("treats a refused quota summary as an auth failure instead of reading legacy quota", async () => {
    const ctx = makeCtx()
    useCachedToken(ctx)
    const calls = routeCloud(ctx, {
      [DAILY + SUMMARY_PATH]: json(401),
      [PROD + SUMMARY_PATH]: json(401),
      [DAILY + "/v1internal:fetchAvailableModels"]: json(200, {
        models: { "gemini-3-pro": { displayName: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.4 } } },
      }),
    })

    const plugin = await loadPlugin()

    expect(() => plugin.probe(ctx)).toThrow("Start Antigravity or run `agy` and try again.")
    expect(calls.some((c) => c.url.includes("fetchAvailableModels"))).toBe(false)
  })

  it("reads agy pool and weekly quotas from the quota summary", async () => {
    const ctx = makeCtx()
    ctx.host.ls.discover.mockReturnValue(null)
    ctx.host.keychain.readGenericPassword.mockReturnValue(JSON.stringify({ access_token: "agy-token" }))
    const calls = routeCloud(ctx, {
      [DAILY + LOAD_PATH]: json(200, { paidTier: { name: "Google AI Pro" }, cloudaicompanionProject: "projects/agy" }),
      [DAILY + SUMMARY_PATH]: json(200, fullSummary()),
    })

    const result = (await loadPlugin()).probe(ctx)

    expect(calls.find((c) => c.url === DAILY + SUMMARY_PATH).body).toEqual({ project: "projects/agy" })
    expect(result.plan).toBe("Google AI Pro")
    expect(result.lines.map((l) => l.label)).toEqual(["Session", "Weekly", "Claude", "Claude Weekly"])
  })

  it("names plans the way Google sells them", async () => {
    const cases = [
      [{ paidTier: { id: "g1-pro-tier", name: "fake" } }, "Google AI Pro"],
      [{ paidTier: { id: "g1-ultra-lite-tier", name: "fake" } }, "Google AI Ultra Lite"],
      [{ paidTier: { id: "unknown", name: "Gemini Code Assist in Google One AI Pro" } }, "Google AI Pro"],
      [{ paidTier: { id: "free-tier", name: "Antigravity Starter Quota" } }, "Antigravity Starter Quota"],
      [{ currentTier: { id: "x", name: "standard" } }, "Standard"],
      [{ paidTier: { id: "unknown", name: "" } }, null],
    ]
    for (const [loadBody, plan] of cases) {
      delete globalThis.__openusage_plugin
      vi.resetModules()
      const ctx = makeCtx()
      useCachedToken(ctx)
      routeCloud(ctx, {
        [PROD + LOAD_PATH]: json(200, loadBody),
        [DAILY + SUMMARY_PATH]: json(200, fullSummary()),
      })

      expect((await loadPlugin()).probe(ctx).plan).toBe(plan)
    }
  })
})
