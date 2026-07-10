import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import VoiceEnrollment from "../VoiceEnrollment";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("VoiceEnrollment", () => {
  it("shows an explicit local 30-second calibration flow", () => {
    render(<VoiceEnrollment />);

    expect(screen.getByText("声纹校准")).toBeInTheDocument();
    expect(screen.getByText("请独自朗读，避免其他人同时说话")).toBeInTheDocument();
    expect(screen.getByText("00:30")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "音频电平" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始校准" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存声纹" })).toBeDisabled();
  });
});
