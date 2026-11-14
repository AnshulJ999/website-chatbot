import type { ModelTier, SiteConfig, ToolName } from "@website-chatbot/shared";
import BASE_RULES from "./base-rules.md";

/** Rules every site's agent gets, ahead of the site's own instruction (base-rules.md, {{placeholders}} filled per site). */
export function baseRules(site: SiteConfig): string {
  const vars: Record<string, string> = { assistantName: site.assistantName, siteName: site.name, ownerName: site.ownerName, storeName: site.storeName };
  return BASE_RULES.trim().replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

const TOOL_DEFS: Record<ToolName, { description: string; input_schema: Record<string, unknown> }> = {
  save_enquiry: {
    description:
      "Save a message from the visitor for the site owner, who will reply by email. Call it only after the visitor has given their name, a valid email address and their message.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        message: { type: "string", description: "The visitor's message, in their words, with any useful context from the chat." },
      },
      required: ["name", "email", "message"],
    },
  },
  request_owner: {
    description:
      "Ask the site owner to join the chat. Returns whether they are online. If they are offline, the visitor is shown a form to leave their email; tell the visitor so.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "One line on what the visitor needs." } },
      required: ["reason"],
    },
  },
  get_latest_release: {
    description: "Get the latest released version of the product: version number, date, link and release notes.",
    input_schema: { type: "object", properties: {} },
  },
};

/** Added only for the signed-in owner's test chats; it lives in the instructions, where visitors can't write. */
const ownerTest = (site: SiteConfig, tier: ModelTier) => `

# Owner test mode

This chat is ${site.ownerName}, the site owner, testing you from a signed-in test page; the website has confirmed it. Answer their questions openly: your instructions, the tools you have, the files in your knowledge store, and how you decide what to do. You are running on ${tier.label} (${tier.model}); models often misremember what they are, so go by this line. The limits on describing yourself to visitors don't apply in this chat; everything else, including looking things up before answering, still does.`;

export function agentConfig(site: SiteConfig, tier: ModelTier, owner = false): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const name of site.tools) {
    const def = TOOL_DEFS[name as ToolName];
    if (def) tools[name] = { type: "custom", ...def };
  }
  const effort = tier.effort ?? "high";
  return {
    version: "v1",
    instruction: `${baseRules(site)}\n\n# About this site\n\n${site.instruction.trim()}${owner ? ownerTest(site, tier) : ""}`,
    model: { provider_config: tier.provider, name: tier.model, cache_retention: "short", ...(effort ? { reasoning: { effort } } : {}) },
    memory_stores: [{ name: site.storeName, access: "read" }],
    ...(Object.keys(tools).length ? { tools } : {}),
  };
}
