import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppRouter from "../../../AppRouter";

const { startAutoSync } = vi.hoisted(() => ({ startAutoSync: vi.fn() }));

vi.mock("../../../hooks/useAuth", () => ({
  useAuth: () => ({ isSignedIn: false, isGracePeriodOnly: false, isLoaded: false }),
}));
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => undefined }));
vi.mock("../../../services/SyncService.js", () => ({
  syncService: { startAutoSync },
}));
vi.mock("../JarvisShell", () => ({ default: () => <div>Jarvis control panel route</div> }));

describe("AppRouter Jarvis isolation", () => {
  beforeEach(() => {
    startAutoSync.mockClear();
    window.history.pushState({}, "", "/control?panel=true");
  });

  it("renders Jarvis before upstream authentication and does not start cloud sync", async () => {
    render(<AppRouter />);

    expect(await screen.findByText("Jarvis control panel route")).toBeInTheDocument();
    await waitFor(() => expect(startAutoSync).not.toHaveBeenCalled());
  });
});
