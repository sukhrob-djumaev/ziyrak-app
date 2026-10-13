import { describe, it, expect, vi } from "vitest";

/**
 * Approving an AI action runs the tool, so the route needs the tool definitions
 * registered. They used to be registered only as a side effect of importing the AI
 * engine, which this route never imports: on a freshly started web process the
 * first approval failed with `Unknown tool "…"` until some chat request happened
 * to load the engine. (Found when a framework upgrade changed module loading.)
 *
 * This starts from an empty module graph, like a new server process, so a test
 * file that imports the builtins itself cannot hide the problem.
 */
describe("the approve route is self-sufficient", () => {
  it("registers the built-in tools when only the route is loaded", async () => {
    vi.resetModules();
    await import("@/app/api/actions/[id]/approve/route");
    const { toolRegistry } = await import("@/lib/tools/registry");
    for (const name of ["create_ticket", "send_internal_email", "trigger_webhook", "noop_test_action"]) {
      expect(toolRegistry.get(name), `${name} should be registered`).toBeDefined();
    }
  });
});
