import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import { agent_tool_result, define_agent_tool } from "../tool-definition";

export const TERM_LOOKUP_PROVIDERS = ["wikipedia", "wiktionary", "jotoba", "jmdict"] as const;
export type TermLookupProvider = (typeof TERM_LOOKUP_PROVIDERS)[number];

export type TermLookupLanguages = Readonly<{
  source: string;
  target: string;
  isDefault: boolean;
}>;

export type TermLookupEntry = Readonly<{
  source: TermLookupProvider;
  language: string;
  title: string;
  url: string;
  summary: string;
  readings: readonly string[];
  senses: readonly string[];
  names: readonly string[];
}>;

export type TermLookupResult = Readonly<{
  query: string;
  languages: TermLookupLanguages;
  results: readonly TermLookupEntry[];
  attribution: readonly string[];
  warnings: readonly string[];
  truncated: boolean;
}>;

export type AgentTermLookupRequest = Readonly<{
  query: string;
  sources?: readonly TermLookupProvider[];
  languages: TermLookupLanguages;
}>;

export function normalize_term_lookup_query(query: string): string {
  return query.trim().normalize("NFKC").toLowerCase();
}

export type AgentTermLookupPort = (
  request: AgentTermLookupRequest,
  signal: AbortSignal,
) => Promise<TermLookupResult>;

/** 查询公开词典与百科，不读取或修改当前工程。 */
export function create_agent_lookup_term_tool(lookup: AgentTermLookupPort): ToolRegistration {
  return define_agent_tool({
    name: "lookup_term",
    description:
      "查询术语、词语或人名的百科释义、读音和词典义项。来源包括 Wikipedia、Wiktionary、Jotoba 和本地 JMdict 常用词包。",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        query: Type.String({ minLength: 1, description: "要查询的词语、术语或人名。" }),
        sources: Type.Optional(
          Type.Array(Type.Enum(Object.fromEntries(TERM_LOOKUP_PROVIDERS.map((p) => [p, p]))), {
            minItems: 1,
            uniqueItems: true,
            description: "可选来源列表；省略时查询所有适用来源。",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await lookup(
        {
          query: params.query,
          ...(params.sources === undefined ? {} : { sources: params.sources }),
          languages: { source: "JA", target: "ZH", isDefault: true },
        },
        signal,
      );
      return agent_tool_result(result as unknown as import("../../../domain/json").JsonRecord);
    },
  });
}
