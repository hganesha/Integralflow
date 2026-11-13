import { describe, expect, it } from "vitest";
import { schedulePreview } from "./Onboarding";

describe("schedule previews", () => {
  it("shows both offsets across the repeated hour at the Chicago daylight saving transition", () => {
    const preview = schedulePreview(Date.parse("2026-11-01T05:30:00Z"), 60, "America/Chicago");
    expect(preview).toContain("CDT"); expect(preview).toContain("CST");
    expect(preview.match(/1:30/g)).toHaveLength(2);
  });
  it("handles invalid intervals and timezones without breaking the setup screen", () => {
    expect(schedulePreview(Date.now(), 0, "UTC")).toContain("Choose an interval");
    expect(schedulePreview(Date.now(), 60, "Invalid/Timezone")).toContain("valid IANA timezone");
  });
});
