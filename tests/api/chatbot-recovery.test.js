import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createChatbotService } from "../../apps/api/src/chatbot/chatbot-service.js";
import { DEFAULT_ASSISTANT_GREETING } from "../../apps/api/src/chatbot/chatbot-constants.js";

const EXPECTED_GREETING = DEFAULT_ASSISTANT_GREETING;

async function source(relativePath) {
  return readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("new chatbot sessions persist the restored assistant greeting", async () => {
  const session = {
    session_id: "22222222-2222-4222-8222-222222222222",
    guest_id: "11111111-1111-4111-8111-111111111111"
  };
  const calls = [];
  const service = createChatbotService({
    repository: {
      async createSession(input) {
        calls.push(["session", input]);
        return session;
      },
      async insertMessage(input) {
        calls.push(["message", input]);
        return { message_id: "33333333-3333-4333-8333-333333333333", ...input };
      }
    }
  });

  const result = await service.createSession({}, {
    guestId: session.guest_id,
    title: "Tư vấn"
  });

  assert.equal(DEFAULT_ASSISTANT_GREETING, EXPECTED_GREETING);
  assert.equal(result.messages[0].text, EXPECTED_GREETING);
  assert.equal(calls[1][1].sender, "bot");
});

test("chatbot frontend renders greeting before session history resolves", async () => {
  const [client, service, repository] = await Promise.all([
    source("apps/user-ng/src/app/features/content/chatbot.page.ts"),
    source("apps/user-ng/src/app/core/services/chatbot.service.ts"),
    source("apps/api/src/chatbot/chatbot-repository.js")
  ]);

  assert.match(client, /messages = signal<ChatMessage\[\]>\(\[localGreeting\(\)\]\)/);
  assert.match(client, /function localGreeting\(\)/);
  assert.match(service, /\/api\/v1\/chat\/messages/);
  assert.match(repository, /CHAT_DB_OPTIONS\s*=\s*Object\.freeze\(\{\s*useAnonKey:\s*false\s*\}\)/);
  assert.match(repository, /CHAT_SERVICE_UNAVAILABLE/);
});

test("policy content is database-backed for frontend and chatbot knowledge", async () => {
  const [migration, repository, llm, service] = await Promise.all([
    source("database/migrations/015_policy_knowledge_content.sql"),
    source("apps/api/src/chatbot/chatbot-repository.js"),
    source("apps/api/src/chatbot/llm-service.js"),
    source("apps/api/src/chatbot/chatbot-service.js")
  ]);

  assert.match(migration, /insert into public\.policy/);
  assert.match(migration, /48 gi/);
  assert.match(migration, /30\.000 VN/);
  assert.match(migration, /500\.000 VN/);
  assert.match(migration, /20 tin/);
  assert.match(repository, /async listPolicies\(\)/);
  assert.match(repository, /async searchPolicies\(query\)/);
  assert.match(repository, /selectRows\("policy"/);
  assert.match(llm, /name:\s*"get_policies"/);
  assert.match(llm, /name:\s*"search_policies"/);
  assert.match(llm, /Database là nguồn đúng duy nhất|Database lÃ  nguá»“n Ä‘Ãºng duy nháº¥t/);
  assert.doesNotMatch(llm, /Chính sách đổi trả:\s*7 ngày|ChÃ­nh sÃ¡ch Ä‘á»•i tráº£:\s*7 ngÃ y/);
  assert.match(service, /repository\.searchPolicies\(message\)/);
  assert.match(service, /getFallbackReply/);
});
