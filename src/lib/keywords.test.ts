import assert from "node:assert/strict";
import test from "node:test";
import { extractKeywords } from "./keywords";

const JD = `We need engineers with strong requirements of their own.
Nice to have incident response experience.
Tools: Go, C++, CI/CD, Node.js, Java, Rust, C#, Kubernetes.`;

test("job keywords keep the eight tools and drop filler", () => {
  const words = extractKeywords(JD);
  for (const skill of ["go", "c++", "ci/cd", "node.js", "java", "rust", "c#", "kubernetes"]) {
    assert.equal(words.includes(skill), true, skill);
  }
  for (const filler of ["requirements", "strong", "own", "nice", "engineers", "incident", "response"]) {
    assert.equal(words.includes(filler), false, filler);
  }
});
