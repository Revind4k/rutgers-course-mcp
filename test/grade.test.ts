import { describe, expect, it } from "vitest";
import { includes } from "../eval/grade.js";

describe("eval grader", () => {
  it("matches numbers as whole tokens only", () => {
    expect(includes("It is worth 4 credits.", "4")).toBe(true);
    expect(includes("01:198:344 is worth 3 credits", "4")).toBe(false);
  });
  it("supports alternatives", () => {
    expect(includes("The data source is down right now.", "unavailable|down")).toBe(true);
  });
});
