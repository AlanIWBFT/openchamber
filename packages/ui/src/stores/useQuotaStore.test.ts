import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { ProviderResult } from "@/types"

let runtimeKey = "url:https://instance-a"
let isInitialized = true
const fetched: string[] = []

type StubPayload = { usageDropdownProviders: string[] } | ProviderResult
const json = (body: StubPayload) => new Response(
  JSON.stringify(body),
  { status: 200, headers: { "content-type": "application/json" } },
)

// Spread the real modules so the overrides stay a patch: `mock.module` is
// process-global, and a partial replacement would break every other module
// that imports something else from these files.
const runtimeSwitch = await import("@/lib/runtime-switch")
mock.module("@/lib/runtime-switch", () => ({ ...runtimeSwitch, getRuntimeKey: () => runtimeKey }))

const runtimeFetchModule = await import("@/lib/runtime-fetch")
mock.module("@/lib/runtime-fetch", () => ({
  ...runtimeFetchModule,
  runtimeFetch: async (path: string) => {
    fetched.push(path)
    if (path.startsWith("/api/config/settings")) return json({ usageDropdownProviders: ["claude"] })
    return json({ providerId: "claude", providerName: "Claude", ok: true, configured: true, usage: null, fetchedAt: 1 })
  },
}))

const configStoreModule = await import("@/stores/useConfigStore")
mock.module("@/stores/useConfigStore", () => ({
  ...configStoreModule,
  useConfigStore: { ...configStoreModule.useConfigStore, getState: () => ({ isInitialized }) },
}))

const { useQuotaStore } = await import("./useQuotaStore")

describe("Usage quotas are loaded once per ready instance", () => {
  beforeEach(() => {
    runtimeKey = "url:https://instance-a"
    isInitialized = true
    fetched.length = 0
    useQuotaStore.getState().resetForRuntimeSwitch()
  })

  test("nothing is fetched while the instance has not reported itself initialised", async () => {
    isInitialized = false
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched).toHaveLength(0)
    expect(useQuotaStore.getState().loadedRuntimeKey).toBeNull()

    // The instance finishes starting up: the same call now performs the load
    // that a mount-time fetch would have answered "nothing configured".
    isInitialized = true
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched.length).toBeGreaterThan(0)
    expect(useQuotaStore.getState().results.length).toBeGreaterThan(0)
  })

  test("a second ask for the same instance does not refetch", async () => {
    await useQuotaStore.getState().ensureLoadedForRuntime()
    const afterFirst = fetched.length
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched.length).toBe(afterFirst)
  })

  test("a switch drops the previous instance's quotas and reloads for the new one", async () => {
    await useQuotaStore.getState().ensureLoadedForRuntime()
    expect(useQuotaStore.getState().results.length).toBeGreaterThan(0)

    useQuotaStore.getState().resetForRuntimeSwitch()
    expect(useQuotaStore.getState().results).toEqual([])
    expect(useQuotaStore.getState().lastUpdated).toBeNull()

    runtimeKey = "url:https://instance-b"
    fetched.length = 0
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched.length).toBeGreaterThan(0)
    expect(useQuotaStore.getState().loadedRuntimeKey).toBe("url:https://instance-b")
  })

  test("a quota still in flight for the previous instance cannot land in the new one", async () => {
    const pending = useQuotaStore.getState().fetchProviderQuota("claude")
    useQuotaStore.getState().resetForRuntimeSwitch()
    await pending

    expect(useQuotaStore.getState().results).toEqual([])
  })

  test("a transient runtime key loads nothing", async () => {
    runtimeKey = "mobile-disconnected"
    await useQuotaStore.getState().ensureLoadedForRuntime()

    expect(fetched).toHaveLength(0)
  })
})
