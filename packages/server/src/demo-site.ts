import type { SiteConfig } from "@website-chatbot/shared";

/** Built-in site used by the Playground in dev mode, so the widget runs before any kb-sync. */
export const DEMO_SITE: SiteConfig = {
  key: "demo",
  name: "Demo",
  assistantName: "Demo Assistant",
  ownerName: "the site owner",
  talkLabel: "Talk to a person",
  greeting: "Hi! I'm an AI assistant. Ask me anything about this site.",
  starters: [
    { path: "/", prompts: ["What is this site about?", "How do I get started?", "What does it cost?", "Is there a free trial?", "Who is behind it?", "Talk to a person"] },
    { path: "/docs", prompts: ["Explain this page", "What are the requirements?"] },
  ],
  contactEmail: "hello@example.com",
  contactUrl: "https://example.com/contact",
  privacyUrl: "https://example.com/privacy",
  noticeText: "Chats are saved so we can read and reply.",
  theme: {},
  ui: {},
  proactive: { enabled: true, delaySec: 20, text: "Questions? I can help." },
  credit: { text: "This chat is open source", url: "https://github.com/AnshulJ999/website-chatbot" },
  origins: [],
  // The scripted brain needs no store; with the real brain, point this at a store you have synced.
  storeName: "website-chatbot-demo",
  instruction: "This is a demo site for trying the chat widget.",
  tools: ["save_enquiry", "request_owner"],
  ownerEmail: "owner@example.com",
  emailFrom: "Demo <chat@example.com>",
};
