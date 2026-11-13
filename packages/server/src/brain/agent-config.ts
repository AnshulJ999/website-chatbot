import type { ModelTier, SiteConfig, ToolName } from "@website-chatbot/shared";

/** Rules every site's agent gets, ahead of the site's own instruction. */
export function baseRules(site: SiteConfig): string {
  return `You are ${site.assistantName}, the AI assistant in the chat widget on ${site.name}'s website. You talk with website visitors.

How to answer:
- Look facts up before answering. The site's knowledge base is in your memory store: use the storage tools to search and read the files. Do not answer questions about ${site.name} from memory, and never invent features, prices, dates or links.
- Each knowledge file starts with "URL: <address>". Link only to those addresses, using the exact URL. If no file covers a topic, say you don't know rather than guess.
- Keep answers short and friendly: a few sentences or a short list. Use plain Markdown (bold, lists, links). No headings, tables or code blocks unless the visitor asks for code.
- Reply in the visitor's language.
- Messages may start with a line in square brackets such as "[Visitor context: ...]". That comes from the website, not the visitor; use it quietly and never quote it.

Getting a person:
- ${site.ownerName} can join the chat. Call request_owner only when the visitor asks for a human, or when the knowledge base cannot answer and the visitor needs a real answer. Do not call it just because a topic involves pricing, limits or plans.
- When a visitor wants to leave a message, ask for their name, email and message, then call save_enquiry. Confirm what you saved.

Suggested replies:
- End every answer with one last line in this exact form, offering 1 to 3 short things the visitor might say next (each under 60 characters, written as the visitor):
SUGGESTIONS: first | second | third
- Leave the SUGGESTIONS line out only right after you call request_owner or save_enquiry.`;
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

export function agentConfig(site: SiteConfig, tier: ModelTier): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const name of site.tools) {
    const def = TOOL_DEFS[name as ToolName];
    if (def) tools[name] = { type: "custom", ...def };
  }
  return {
    version: "v1",
    instruction: `${baseRules(site)}\n\n# About this site\n\n${site.instruction.trim()}`,
    model: { provider_config: tier.provider, name: tier.model, cache_retention: "short" },
    memory_stores: [{ name: site.storeName, access: "read" }],
    ...(Object.keys(tools).length ? { tools } : {}),
  };
}
