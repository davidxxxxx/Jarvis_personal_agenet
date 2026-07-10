import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import i18n from "../../../i18n";
import LiveTranscript from "../LiveTranscript";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("LiveTranscript", () => {
  it("sorts stable rows by timestamp and renders partial text separately", () => {
    render(
      <LiveTranscript
        segments={[
          { id: "late", text: "后一句", source: "mic", timestamp: 2_000 },
          { id: "early", text: "前一句", source: "mic", timestamp: 1_000 },
        ]}
        partialText="临时内容"
      />
    );

    const rows = screen.getAllByTestId("stable-transcript-row");
    expect(rows[0]).toHaveTextContent("前一句");
    expect(rows[1]).toHaveTextContent("后一句");
    expect(screen.getByLabelText("临时转写")).toHaveTextContent("临时内容");
    expect(screen.getByLabelText("临时转写")).toHaveClass("opacity-50");
  });
});
