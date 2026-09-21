import { z } from "zod";
import type { ToolDefinition as ProviderToolDefinition } from "@/lib/ai/providers/types";
import type { ToolDefinition } from "./types";

/**
 * Converts a `ToolDefinition.schema` (Zod, the single source of truth per
 * §23.2) into the JSON-schema `parameters` shape `AIProvider.complete()`
 * expects (`ai/providers/types.ts`'s `ToolDefinition.function.parameters`).
 * `z.toJSONSchema()` (Zod 4) includes a `$schema` meta key providers don't
 * expect in a function-parameters object — stripped here.
 */
export function toProviderToolDefinition(tool: ToolDefinition): ProviderToolDefinition {
  const parameters = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete parameters.$schema;

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}
