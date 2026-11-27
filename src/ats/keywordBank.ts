/**
 * Batch 3: keyword bank for the Advanced ATS Checker — skills / tools dictionary, synonym groups,
 * a light stemmer and role benchmarks (used when no job description is pasted). Deterministic.
 */

/** Synonym groups: the first entry is the canonical label shown to the user. */
export const SYNONYMS: string[][] = [
  ["javascript", "js", "es6", "ecmascript"],
  ["typescript", "ts"],
  ["kubernetes", "k8s"],
  ["react", "reactjs", "react.js"],
  ["node.js", "nodejs", "node"],
  ["next.js", "nextjs"],
  ["vue", "vuejs", "vue.js"],
  ["angular", "angularjs"],
  ["postgresql", "postgres", "psql"],
  ["mongodb", "mongo"],
  ["golang", "go"],
  ["c#", "csharp"],
  ["c++", "cpp"],
  [".net", "dotnet", "asp.net"],
  ["aws", "amazon web services"],
  ["gcp", "google cloud", "google cloud platform"],
  ["azure", "microsoft azure"],
  ["ci/cd", "cicd", "continuous integration", "continuous delivery", "continuous deployment"],
  ["machine learning", "ml"],
  ["artificial intelligence", "ai"],
  ["natural language processing", "nlp"],
  ["user experience", "ux"],
  ["user interface", "ui"],
  ["search engine optimization", "seo"],
  ["customer relationship management", "crm"],
  ["key performance indicators", "kpis", "kpi"],
  ["objectives and key results", "okrs", "okr"],
  ["project management", "pm", "pmp"],
  ["quality assurance", "qa"],
  ["business intelligence", "bi"],
  ["power bi", "powerbi"],
  ["microsoft excel", "excel", "ms excel", "spreadsheets"],
  ["rest api", "rest", "restful", "rest apis", "restful apis"],
  ["github actions", "gh actions"],
  ["infrastructure as code", "iac"],
  ["site reliability engineering", "sre"],
  ["software development life cycle", "sdlc"],
  ["accounts payable", "ap"],
  ["accounts receivable", "ar"],
  ["human resources", "hr"],
  ["electronic health records", "ehr", "emr"],
  ["b2b", "business to business"],
  ["saas", "software as a service"],
];

/** Semantic families: related terms that count as a partial ("semantic") match. */
export const SEMANTIC: string[][] = [
  ["ci/cd", "devops", "jenkins", "github actions", "gitlab ci", "circleci", "argo cd"],
  ["kubernetes", "docker", "containers", "helm", "eks", "aks", "gke"],
  ["aws", "ec2", "s3", "lambda", "cloudformation", "eks"],
  ["terraform", "infrastructure as code", "pulumi", "cloudformation", "ansible"],
  ["react", "next.js", "redux", "frontend"],
  ["sql", "postgresql", "mysql", "sql server", "oracle"],
  ["agile", "scrum", "kanban", "sprint planning"],
  ["data analysis", "data analytics", "analytics", "sql", "tableau", "power bi"],
  ["stakeholder management", "cross-functional collaboration", "stakeholders"],
  ["product management", "product strategy", "roadmapping", "roadmap"],
  ["observability", "monitoring", "prometheus", "grafana", "datadog"],
  ["machine learning", "deep learning", "tensorflow", "pytorch", "scikit-learn"],
  ["user experience", "user research", "usability testing", "figma", "prototyping"],
  ["digital marketing", "seo", "sem", "google ads", "content marketing", "email marketing"],
  ["sales", "business development", "lead generation", "pipeline management"],
  ["customer support", "customer service", "customer success", "zendesk"],
];

/** Skills and tools the extractor recognises in a job description (lowercase). */
export const SKILL_TERMS: string[] = [
  // engineering
  "python", "java", "javascript", "typescript", "go", "golang", "rust", "kotlin", "swift", "ruby", "php", "scala", "c#", "c++",
  ".net", "react", "next.js", "vue", "angular", "node.js", "express", "django", "flask", "fastapi", "spring", "spring boot",
  "graphql", "rest api", "microservices", "html", "css", "tailwind", "redux", "sql", "postgresql", "mysql", "mongodb", "redis",
  "elasticsearch", "kafka", "rabbitmq", "aws", "azure", "gcp", "docker", "kubernetes", "helm", "terraform", "ansible",
  "pulumi", "jenkins", "github actions", "gitlab ci", "circleci", "argo cd", "ci/cd", "devops", "linux", "bash", "git",
  "prometheus", "grafana", "datadog", "observability", "monitoring", "nginx", "serverless", "lambda", "ec2", "s3", "eks",
  "iam", "networking", "security", "site reliability engineering", "infrastructure as code", "unit testing", "jest",
  "cypress", "playwright", "selenium", "test automation", "quality assurance", "system design", "distributed systems",
  "api design", "performance optimization", "mobile", "ios", "android", "flutter", "react native",
  // data / ai
  "machine learning", "deep learning", "artificial intelligence", "natural language processing", "tensorflow", "pytorch",
  "scikit-learn", "pandas", "numpy", "spark", "airflow", "dbt", "snowflake", "bigquery", "databricks", "etl",
  "data analysis", "data analytics", "data visualization", "data modeling", "statistics", "a/b testing", "tableau",
  "power bi", "looker", "microsoft excel", "llm", "generative ai",
  // product / design
  "product management", "product strategy", "roadmapping", "user research", "usability testing", "user experience",
  "user interface", "figma", "sketch", "prototyping", "wireframing", "design systems", "accessibility", "okrs",
  "key performance indicators", "go-to-market", "market research", "saas", "b2b", "jira", "confluence",
  // business
  "agile", "scrum", "kanban", "project management", "program management", "stakeholder management", "budgeting",
  "forecasting", "financial modeling", "financial analysis", "accounting", "gaap", "ifrs", "audit", "compliance",
  "risk management", "accounts payable", "accounts receivable", "payroll", "quickbooks", "sap", "erp", "salesforce",
  "hubspot", "customer relationship management", "crm", "negotiation", "business development", "lead generation",
  "account management", "customer success", "customer service", "customer support", "zendesk", "sales",
  "digital marketing", "content marketing", "email marketing", "social media", "search engine optimization", "sem",
  "google ads", "google analytics", "copywriting", "brand strategy", "public relations", "event planning",
  "supply chain", "logistics", "procurement", "inventory management", "operations management", "lean", "six sigma",
  "process improvement", "vendor management", "human resources", "recruiting", "talent acquisition", "onboarding",
  "employee relations", "training", "coaching", "leadership", "team leadership", "mentoring", "communication",
  "presentation", "problem solving", "cross-functional collaboration", "time management", "requirements gathering",
  "user stories", "process mapping", "business analysis",
  // healthcare / education
  "patient care", "electronic health records", "clinical", "hipaa", "bls", "cpr", "medication administration",
  "curriculum development", "lesson planning", "classroom management", "student assessment",
];

/** Terms counted as tools / tech stack (RemoteOK, "Nice-to-have / Tools" grouping). */
export const TOOL_TERMS = new Set<string>([
  "python", "java", "javascript", "typescript", "go", "golang", "rust", "kotlin", "swift", "ruby", "php", "scala", "c#", "c++",
  ".net", "react", "next.js", "vue", "angular", "node.js", "express", "django", "flask", "fastapi", "spring", "spring boot",
  "graphql", "rest api", "html", "css", "tailwind", "redux", "sql", "postgresql", "mysql", "mongodb", "redis",
  "elasticsearch", "kafka", "rabbitmq", "aws", "azure", "gcp", "docker", "kubernetes", "helm", "terraform", "ansible",
  "pulumi", "jenkins", "github actions", "gitlab ci", "circleci", "argo cd", "linux", "bash", "git", "prometheus", "grafana",
  "datadog", "nginx", "lambda", "ec2", "s3", "eks", "jest", "cypress", "playwright", "selenium", "flutter", "react native",
  "tensorflow", "pytorch", "scikit-learn", "pandas", "numpy", "spark", "airflow", "dbt", "snowflake", "bigquery",
  "databricks", "tableau", "power bi", "looker", "microsoft excel", "figma", "sketch", "jira", "confluence", "salesforce",
  "hubspot", "quickbooks", "sap", "zendesk", "google ads", "google analytics",
]);

/** Role benchmarks for the "no job description" mode. Matched against the headline / latest title. */
export const ROLE_BENCHMARKS: Array<{ id: string; label: string; match: RegExp; keywords: string[] }> = [
  { id: "devops", label: "DevOps / Cloud Engineer", match: /devops|sre|site reliability|cloud|platform engineer|infrastructure/i,
    keywords: ["aws", "kubernetes", "docker", "terraform", "ci/cd", "linux", "python", "monitoring", "helm", "ansible", "git", "security"] },
  { id: "frontend", label: "Frontend Developer", match: /front[\s-]?end|ui engineer|react|web developer/i,
    keywords: ["javascript", "typescript", "react", "html", "css", "next.js", "rest api", "unit testing", "accessibility", "git", "performance optimization", "redux"] },
  { id: "backend", label: "Backend Developer", match: /back[\s-]?end|api|server|java developer|python developer|node/i,
    keywords: ["python", "java", "node.js", "sql", "postgresql", "rest api", "microservices", "docker", "aws", "redis", "unit testing", "system design"] },
  { id: "software", label: "Software Engineer", match: /software|developer|engineer|programmer|full[\s-]?stack/i,
    keywords: ["javascript", "typescript", "python", "sql", "rest api", "git", "docker", "aws", "unit testing", "agile", "system design", "ci/cd"] },
  { id: "data", label: "Data Analyst / Scientist", match: /data|analytics|machine learning|ml engineer|bi analyst|scientist/i,
    keywords: ["sql", "python", "data analysis", "statistics", "tableau", "power bi", "microsoft excel", "machine learning", "data visualization", "etl", "a/b testing", "pandas"] },
  { id: "product", label: "Product Manager", match: /product (manager|owner|lead)|\bpm\b|product management/i,
    keywords: ["product strategy", "roadmapping", "user research", "agile", "stakeholder management", "okrs", "data analysis", "a/b testing", "go-to-market", "jira", "cross-functional collaboration", "key performance indicators"] },
  { id: "design", label: "Product / UX Designer", match: /design|ux|ui\b/i,
    keywords: ["figma", "user research", "prototyping", "wireframing", "usability testing", "design systems", "user experience", "user interface", "accessibility", "cross-functional collaboration"] },
  { id: "marketing", label: "Marketing", match: /marketing|seo|content|growth|brand|social media/i,
    keywords: ["digital marketing", "search engine optimization", "content marketing", "email marketing", "google analytics", "social media", "google ads", "copywriting", "a/b testing", "brand strategy", "hubspot"] },
  { id: "sales", label: "Sales / Business Development", match: /sales|account (executive|manager)|business development|bdr|sdr/i,
    keywords: ["sales", "lead generation", "negotiation", "salesforce", "customer relationship management", "account management", "business development", "forecasting", "communication", "presentation"] },
  { id: "finance", label: "Finance / Accounting", match: /financ|account(ant|ing)|controller|auditor|bookkeep/i,
    keywords: ["financial analysis", "financial modeling", "forecasting", "budgeting", "microsoft excel", "gaap", "accounts payable", "accounts receivable", "audit", "erp", "compliance"] },
  { id: "hr", label: "HR / Recruiting", match: /\bhr\b|human resources|recruit|talent|people (partner|operations)/i,
    keywords: ["recruiting", "talent acquisition", "onboarding", "employee relations", "human resources", "payroll", "compliance", "training", "communication", "stakeholder management"] },
  { id: "operations", label: "Operations", match: /operations|supply chain|logistics|procurement|warehouse/i,
    keywords: ["operations management", "supply chain", "logistics", "process improvement", "inventory management", "vendor management", "budgeting", "lean", "key performance indicators", "stakeholder management"] },
  { id: "support", label: "Customer Support / Success", match: /support|customer (service|success)|help ?desk/i,
    keywords: ["customer support", "customer service", "customer success", "zendesk", "crm", "communication", "problem solving", "onboarding", "key performance indicators"] },
  { id: "healthcare", label: "Healthcare", match: /nurse|clinical|medical|health|patient|pharmac/i,
    keywords: ["patient care", "electronic health records", "clinical", "hipaa", "bls", "cpr", "medication administration", "communication"] },
  { id: "education", label: "Education", match: /teacher|tutor|lecturer|instructor|education/i,
    keywords: ["curriculum development", "lesson planning", "classroom management", "student assessment", "communication", "mentoring", "training"] },
  { id: "analyst", label: "Business Analyst", match: /analyst|business analysis/i,
    keywords: ["requirements gathering", "stakeholder management", "sql", "data analysis", "process improvement", "agile", "jira", "microsoft excel", "power bi", "user stories", "process mapping", "communication"] },
  { id: "general", label: "General professional", match: /./,
    keywords: ["communication", "leadership", "project management", "problem solving", "stakeholder management", "microsoft excel", "time management", "process improvement"] },
];

/** Strong action verbs (lowercase, past tense) for bullet openings. */
export const STRONG_VERBS = new Set<string>([
  "accelerated", "achieved", "administered", "advised", "analyzed", "architected", "automated", "boosted", "built", "captured",
  "championed", "coached", "collaborated", "configured", "consolidated", "created", "cut", "decreased", "defined", "delivered",
  "deployed", "designed", "developed", "directed", "doubled", "drove", "eliminated", "enabled", "engineered", "established",
  "exceeded", "expanded", "facilitated", "founded", "generated", "grew", "guided", "headed", "implemented", "improved",
  "increased", "initiated", "integrated", "introduced", "launched", "led", "maintained", "managed", "mentored", "migrated",
  "modernized", "monitored", "negotiated", "optimized", "orchestrated", "organized", "overhauled", "oversaw", "owned",
  "partnered", "piloted", "planned", "produced", "programmed", "published", "raised", "rebuilt", "reduced", "redesigned",
  "refactored", "resolved", "restructured", "revamped", "saved", "scaled", "secured", "shipped", "simplified", "spearheaded",
  "standardized", "streamlined", "strengthened", "supervised", "supported", "taught", "tested", "trained", "transformed",
  "tripled", "upgraded", "won", "wrote", "conducted", "coordinated", "executed", "prepared", "processed", "reconciled",
  "recruited", "served", "handled", "audited", "authored", "closed", "crafted", "curated", "diagnosed", "documented",
  "evaluated", "forecasted", "hired", "identified", "influenced", "instituted", "investigated", "modeled", "mobilized",
  "operated", "performed", "presented", "prioritized", "promoted", "provided", "researched", "reviewed", "shaped", "sourced",
  "trimmed", "unified", "validated", "contributed",
]);

/** Weak / passive openers and phrases. `fix` is the stronger replacement used by the deterministic rewrite. */
export const WEAK_PHRASES: Array<{ re: RegExp; label: string; fix: string }> = [
  { re: /\b(?:was |were )?responsible for\b/i, label: "responsible for", fix: "Owned" },
  { re: /\bhelped (?:with|to|in)?\b/i, label: "helped with", fix: "Supported" },
  { re: /\bworked on\b/i, label: "worked on", fix: "Delivered" },
  { re: /\bduties (?:included|include)\b/i, label: "duties included", fix: "Owned" },
  { re: /\bassisted (?:with|in)\b/i, label: "assisted with", fix: "Supported" },
  { re: /\btasked with\b/i, label: "tasked with", fix: "Owned" },
  { re: /\b(?:was )?involved in\b/i, label: "involved in", fix: "Contributed to" },
  { re: /\bparticipated in\b/i, label: "participated in", fix: "Contributed to" },
  { re: /\bin charge of\b/i, label: "in charge of", fix: "Led" },
  { re: /\bhandled the\b/i, label: "handled the", fix: "Managed the" },
];

const IRREGULAR: Record<string, string> = {
  build: "built", lead: "led", run: "ran", write: "wrote", oversee: "oversaw", drive: "drove", make: "made", teach: "taught",
  sell: "sold", grow: "grew", win: "won", bring: "brought", set: "set", cut: "cut", speak: "spoke", hold: "held", keep: "kept",
  begin: "began", take: "took", give: "gave", see: "saw", meet: "met", spend: "spent", pay: "paid", send: "sent", buy: "bought",
  get: "got", put: "put", do: "did", go: "went", find: "found", think: "thought",
};
const GERUND_BASE: Record<string, string> = {
  building: "build", leading: "lead", running: "run", writing: "write", overseeing: "oversee", driving: "drive", making: "make",
  teaching: "teach", selling: "sell", growing: "grow", winning: "win", bringing: "bring", setting: "set", cutting: "cut",
  speaking: "speak", holding: "hold", keeping: "keep", beginning: "begin", taking: "take", giving: "give", seeing: "see",
  meeting: "meet", spending: "spend", paying: "pay", sending: "send", buying: "buy", getting: "get", putting: "put",
  doing: "do", going: "go", finding: "find", thinking: "think",
};

/** "managing" -> "managed", "building" -> "built", "planning" -> "planned", "supplying" -> "supplied". */
export function gerundToPast(word: string): string | null {
  const w = word.toLowerCase();
  if (!w.endsWith("ing") || w.length < 5) return null;
  if (GERUND_BASE[w]) return IRREGULAR[GERUND_BASE[w]] ?? null;
  const stem = w.slice(0, -3);
  if (/[^aeiou]y$/.test(stem)) return `${stem.slice(0, -1)}ied`;
  return `${stem}ed`;
}

/** Light stemmer: lowercase word -> stem (managing / managed / management -> manag). */
export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 4) return w.replace(/s$/, "");
  for (const suf of ["ations", "ation", "ments", "ment", "ings", "ing", "ers", "er", "ies", "ied", "ed", "es", "s", "ly"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) {
      w = w.slice(0, -suf.length);
      if (suf === "ies" || suf === "ied") w += "y";
      break;
    }
  }
  return w.replace(/e$/, "");
}

const CANON = new Map<string, string>();
for (const group of SYNONYMS) for (const term of group) CANON.set(term, group[0]);

/** Canonical label for a term ("k8s" -> "kubernetes", "ReactJS" -> "react"). */
export function canonical(term: string): string {
  const t = term.toLowerCase().trim();
  return CANON.get(t) ?? t;
}

/** Every spelling of a term (canonical + synonyms). */
export function variants(term: string): string[] {
  const c = canonical(term);
  const group = SYNONYMS.find((g) => g[0] === c);
  return group ? [...group] : [c];
}

/** Semantic neighbours of a term (partial credit). */
export function neighbours(term: string): string[] {
  const c = canonical(term);
  const out = new Set<string>();
  for (const fam of SEMANTIC) if (fam.includes(c)) for (const t of fam) if (t !== c) out.add(t);
  return [...out];
}
