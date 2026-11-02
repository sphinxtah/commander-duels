import { it } from "vitest";
import { buildDemo } from "./demoScript";
it("count", () => { const b = buildDemo(); console.log("LESSONS", b.length, b.map(x => x.title+":"+x.frames.length+":"+x.text.split(/\s+/).length).join(" | ")); });
