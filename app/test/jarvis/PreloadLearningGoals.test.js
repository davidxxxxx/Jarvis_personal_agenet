"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function loadPreloadApi() {
  let exposed;
  const invokes = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name, value) {
        exposed = value;
      },
    },
    ipcRenderer: {
      invoke(...args) {
        invokes.push(args);
        return Promise.resolve(null);
      },
      send() {},
      on() {},
      removeListener() {},
    },
    webUtils: {},
  };
  const preloadPath = path.resolve(__dirname, "../../preload.js");
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }
  return { api: exposed.jarvis, invokes };
}

test("preload exposes the complete learning goal lifecycle with exact local inputs", async () => {
  const { api, invokes } = loadPreloadApi();

  await api.listLearningGoals();
  await api.createLearningGoal("  学习   英语  ");
  await api.editLearningGoal("goal_1", "练习口语");
  await api.archiveLearningGoal("goal_1");
  await api.restoreLearningGoal("goal_1");
  await api.deleteLearningGoal("goal_1");

  assert.deepEqual(invokes, [
    ["jarvis:learning-goals:list"],
    ["jarvis:learning-goals:create", { title: "学习 英语" }],
    ["jarvis:learning-goals:edit", { goalId: "goal_1", title: "练习口语" }],
    ["jarvis:learning-goals:archive", { goalId: "goal_1" }],
    ["jarvis:learning-goals:restore", { goalId: "goal_1" }],
    ["jarvis:learning-goals:delete", { goalId: "goal_1" }],
  ]);
});

test("preload rejects malformed learning goal titles and ids before IPC", () => {
  const { api, invokes } = loadPreloadApi();

  for (const operation of [
    () => api.createLearningGoal(""),
    () => api.createLearningGoal("x".repeat(501)),
    () => api.editLearningGoal("../private", "英语"),
    () => api.editLearningGoal("goal_1", ""),
    () => api.archiveLearningGoal("../private"),
    () => api.restoreLearningGoal(""),
    () => api.deleteLearningGoal("C:\\private"),
  ]) {
    assert.throws(operation);
  }
  assert.deepEqual(invokes, []);
});
