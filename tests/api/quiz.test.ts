import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleQuizRoute, guestStyleProfiles } from "../../apps/api/src/user/quiz.js";

test("handleQuizRoute processes guest GET/POST operations", async () => {
  // Clear any existing guest state
  guestStyleProfiles.clear();

  // Test 1: GET empty guest profile
  const reqGet = {
    method: "GET",
    url: "/api/user/style-quiz",
    headers: { "x-guest-session-id": "test-guest-session" }
  };
  
  let status = null;
  let json = null;
  const resGet = {
    setHeader: () => {},
    writeHead: (code) => { status = code; },
    end: (str) => { json = JSON.parse(str); }
  };

  await handleQuizRoute(reqGet, resGet, {}, {});
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.quiz, null);

  // Test 2: POST guest profile
  const quizData = { height_cm: 170, weight_kg: 60, body_shape: "Pear" };
  const reqPost = Readable.from([JSON.stringify(quizData)]);
  reqPost.method = "POST";
  reqPost.url = "/api/user/style-quiz";
  reqPost.headers = { "x-guest-session-id": "test-guest-session" };

  let postStatus = null;
  let postJson = null;
  const resPost = {
    setHeader: () => {},
    writeHead: (code) => { postStatus = code; },
    end: (str) => { postJson = JSON.parse(str); }
  };

  await handleQuizRoute(reqPost, resPost, {}, {});
  assert.equal(postStatus, 200);
  assert.equal(postJson.success, true);
  assert.deepEqual(postJson.quiz, quizData);

  // Verify in-memory map has it
  assert.deepEqual(guestStyleProfiles.get("test-guest-session"), quizData);

  // Test 3: GET now returns the saved profile
  const reqGet2 = {
    method: "GET",
    url: "/api/user/style-quiz",
    headers: { "x-guest-session-id": "test-guest-session" }
  };
  
  let get2Status = null;
  let get2Json = null;
  const resGet2 = {
    setHeader: () => {},
    writeHead: (code) => { get2Status = code; },
    end: (str) => { get2Json = JSON.parse(str); }
  };

  await handleQuizRoute(reqGet2, resGet2, {}, {});
  assert.equal(get2Status, 200);
  assert.equal(get2Json.success, true);
  assert.deepEqual(get2Json.quiz, quizData);
});
