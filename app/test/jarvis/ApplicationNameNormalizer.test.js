const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeApplicationIdentity,
  normalizeProcessApplications,
} = require("../../src/helpers/applicationNameNormalizer");

test("normalizes known multi-process applications into one stable identity", () => {
  assert.deepEqual(normalizeApplicationIdentity("C:\\Program Files\\Google\\Chrome\\chrome.exe"), {
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
  });
  assert.deepEqual(normalizeApplicationIdentity("chrome.exe"), {
    applicationKey: "chrome",
    applicationDisplayName: "Chrome",
  });
  assert.deepEqual(normalizeApplicationIdentity("wemeetapp.exe"), {
    applicationKey: "tencent_meeting",
    applicationDisplayName: "腾讯会议",
  });
  assert.deepEqual(normalizeApplicationIdentity("Weixin.exe"), {
    applicationKey: "wechat",
    applicationDisplayName: "微信",
  });
  assert.deepEqual(normalizeApplicationIdentity("Quark.exe"), {
    applicationKey: "quark",
    applicationDisplayName: "Quark",
  });
  assert.deepEqual(
    normalizeProcessApplications([
      { pid: 11, name: "chrome.exe" },
      { pid: 12, name: "chrome.exe" },
      { pid: 13, name: "KOOK.exe" },
    ]),
    new Map([
      [11, { applicationKey: "chrome", applicationDisplayName: "Chrome" }],
      [12, { applicationKey: "chrome", applicationDisplayName: "Chrome" }],
      [13, { applicationKey: "kook", applicationDisplayName: "KOOK" }],
    ])
  );
});

test("returns only canonical keys and bounded display names for unknown executables", () => {
  assert.deepEqual(normalizeApplicationIdentity("My Study Player.exe"), {
    applicationKey: "my-study-player",
    applicationDisplayName: "My Study Player",
  });
  assert.deepEqual(normalizeApplicationIdentity("奇怪播放器.exe"), {
    applicationKey: "application-fd43f11e",
    applicationDisplayName: "奇怪播放器",
  });
  assert.equal(normalizeApplicationIdentity("C:\\private\\folder\\"), null);
});

test("filters Jarvis helpers and never returns a raw path or window title field", () => {
  for (const name of [
    "Jarvis Memory.exe",
    "windows-system-audio-helper.exe",
    "whisper-server.exe",
    "ffmpeg.exe",
  ]) {
    assert.equal(normalizeApplicationIdentity(name), null);
  }
  const result = normalizeApplicationIdentity("C:\\Users\\private\\Games\\dota2.exe");
  assert.deepEqual(result, {
    applicationKey: "dota2",
    applicationDisplayName: "DOTA 2",
  });
  assert.equal(JSON.stringify(result).includes("C:\\Users"), false);
  assert.deepEqual(Object.keys(result), ["applicationKey", "applicationDisplayName"]);
});
