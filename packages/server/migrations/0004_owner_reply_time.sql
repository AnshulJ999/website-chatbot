-- When the owner last wrote in the chat, so the widget can tell a returning visitor about a reply.
ALTER TABLE chats ADD COLUMN owner_at INTEGER;
