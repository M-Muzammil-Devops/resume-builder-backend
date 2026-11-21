const STOP = new Set([
  "the", "and", "for", "with", "you", "your", "our", "are", "will", "this", "that",
  "from", "have", "has", "been", "using", "into", "about", "work", "role", "team",
  "job", "jobs", "a", "an", "to", "of", "in", "on", "or", "we", "as", "be", "is",
  "it", "at", "by", "not", "but", "can", "all", "any", "their", "they", "who",
  "requirements", "requirement", "strong", "own", "nice", "engineers", "engineer",
  "incident", "response", "experience", "experiences", "skills", "skill", "ability",
  "including", "such", "other", "must", "should", "plus", "years", "year",
]);

const SKILLS = new Set([
  "go", "java", "rust", "kotlin", "swift", "ruby", "php", "scala", "elixir", "python",
  "javascript", "typescript", "react", "sql", "aws", "azure", "gcp", "docker",
  "kubernetes", "k8s", "terraform", "ansible", "linux", "git", "html", "css",
  "graphql", "redis", "postgres", "kafka", "jenkins", "helm", "grafana", "prometheus",
  "devops", "sre", "microservices", "iam", "eks", "rest", "api", "golang", "node",
  "c", "cpp",
]);

const PHRASES = ["ci/cd", "c++", "node.js", "react.js", "next.js", ".net", "c#", "github actions"];

/** Skills named in a job description. Filler words are dropped. C#, C++, .NET and Node.js stay. */
export function extractKeywords(jd: string): string[] {
  const text = jd.toLowerCase().replace(/[“”"']/g, "");
  const found = new Set<string>();
  for (const phrase of PHRASES) {
    if (text.includes(phrase)) found.add(phrase);
  }
  const words = text
    .replace(/ci\/cd|c\+\+|node\.js|react\.js|next\.js|\.net|c#|github actions/g, " ")
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^[.+]+|[.+]+$/g, ""))
    .filter(Boolean);
  for (const word of words) {
    if (STOP.has(word)) continue;
    if (word === "c#" || word.includes("#") || word.includes("+") || word.startsWith(".")) {
      found.add(word);
      continue;
    }
    if (SKILLS.has(word)) found.add(word);
  }
  return [...found].slice(0, 40);
}
