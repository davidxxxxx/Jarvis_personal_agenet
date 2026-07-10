const test = require("node:test");
const assert = require("node:assert/strict");
const TrayManager = require("../../src/helpers/tray");
const { changeLanguage } = require("../../src/helpers/i18nMain");

function makeControlPanel(sent) {
  return {
    on() {},
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    focus() {},
    webContents: {
      isCrashed: () => false,
      send: (channel, action) => sent.push([channel, action]),
    },
  };
}

test("recording and paused tray states expose truthful Chinese labels and tooltip", async () => {
  changeLanguage("zh-CN");
  const manager = new TrayManager();
  const sent = [];
  manager.controlPanelWindow = makeControlPanel(sent);

  try {
    manager.setJarvisState({ status: "recording", errorCode: null });
    const recordingMenu = manager.buildContextMenuTemplate();
    const pause = recordingMenu.find((item) => item.label === "暂停");
    const finish = recordingMenu.find((item) => item.label === "结束并总结");
    assert.equal(manager.getJarvisTooltip(), "Jarvis Memory · 正在监听");
    assert.ok(pause);
    assert.ok(finish);

    await pause.click();
    await finish.click();
    assert.deepEqual(sent, [
      ["jarvis:control", "pause"],
      ["jarvis:control", "finish"],
    ]);

    manager.setJarvisState({ status: "paused", errorCode: null });
    const pausedMenu = manager.buildContextMenuTemplate();
    const resume = pausedMenu.find((item) => item.label === "继续");
    assert.equal(manager.getJarvisTooltip(), "Jarvis Memory · 已暂停");
    assert.ok(resume);
    assert.ok(pausedMenu.find((item) => item.label === "结束并总结"));

    await resume.click();
    assert.deepEqual(sent.at(-1), ["jarvis:control", "resume"]);

    manager.setJarvisState({ status: "paused", errorCode: "MIC_DISCONNECTED" });
    assert.equal(
      manager.getJarvisTooltip(),
      "Jarvis Memory · 已暂停 · 录音无法继续，请检查麦克风后重试。"
    );
  } finally {
    changeLanguage("en");
  }
});

test("idle and terminal tray states offer start through the renderer control channel", async () => {
  changeLanguage("en");
  const manager = new TrayManager();
  const sent = [];
  manager.controlPanelWindow = makeControlPanel(sent);

  for (const status of ["idle", "completed", "failed", "recovered"]) {
    manager.setJarvisState({ status, errorCode: null });
    const start = manager
      .buildContextMenuTemplate()
      .find((item) => item.label === "Start listening");
    assert.ok(start, `missing start action for ${status}`);
    await start.click();
  }

  assert.deepEqual(
    sent.map((entry) => entry[1]),
    ["start", "start", "start", "start"]
  );
});
