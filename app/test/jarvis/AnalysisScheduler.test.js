const test = require("node:test");
const assert = require("node:assert/strict");
const AnalysisScheduler = require("../../src/jarvis/main/AnalysisScheduler");

test("deduplicates concurrent analysis and persists pseudonymous text-only results", async () => {
  let resolve;
  const calls = [];
  const applied = [];
  const repository = {
    getSessionDetail: () => ({
      session: { id: "s1", started_at: 1 },
      summary: null,
      segments: [
        {
          id: "seg-1",
          started_at: 2,
          ended_at: 3,
          person_id: "p-real",
          speaker_label: "张三",
          text: "讨论交付",
          is_stable: 1,
        },
      ],
    }),
    listPeople: () => [{ id: "p-real", display_name: "张三", is_self: 0 }],
    applyAnalysisResult: (input) => applied.push(input),
  };
  const client = {
    analyze: (input) => {
      calls.push(input);
      return new Promise((done) => {
        resolve = () =>
          done({
            result: {
              summary: "交付",
              topics: [],
              memories: [],
              todos: [],
              decisions: [],
              suggestions: [],
            },
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "MiniMax-M2.7",
          });
      });
    },
  };
  const scheduler = new AnalysisScheduler({
    repository,
    client,
    createId: () => "run-1",
    now: () => 10,
  });
  const first = scheduler.analyzeSession("s1", "incremental");
  const second = scheduler.analyzeSession("s1", "incremental");
  assert.strictEqual(first, second);
  resolve();
  await first;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].segments[0].speakerRef, "person_2");
  assert.doesNotMatch(JSON.stringify(calls[0]), /张三/);
  assert.equal(applied.length, 1);
  assert.equal(scheduler.getStatus("s1").state, "ready");
});
