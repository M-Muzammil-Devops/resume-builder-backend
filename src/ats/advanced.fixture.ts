/** Test fixtures for the Advanced ATS Checker (Batch 3). */
export const STRONG_RESUME = {
  leftColumnIds: ["s", "e", "ed", "k"],
  rightColumnIds: [],
  sections: [
    {
      type: "header",
      id: "h",
      fullName: "Sara Malik",
      title: "Senior DevOps Engineer",
      contact: { email: "sara@example.com", phone: "+92 300 1234567", location: "Lahore, Pakistan", linkedin: "linkedin.com/in/sara", github: "github.com/sara" },
    },
    {
      type: "summary",
      id: "s",
      title: "Summary",
      content: "<p>Senior DevOps engineer with 7 years building reliable AWS platforms. Cut release time by 60% with CI/CD and Kubernetes, and led a team of 6 engineers.</p>",
    },
    {
      type: "experience",
      id: "e",
      title: "Experience",
      items: [
        {
          id: "e1", title: "Senior DevOps Engineer", company: "Acme Cloud", startDate: "Jan 2022", endDate: "Present", location: "Remote",
          bullets: [
            "Cut deployment time by 60% by rebuilding GitHub Actions pipelines for 35 services",
            "Migrated 40 microservices to <b>K8s</b> on EKS with Helm, saving $120k per year",
            "Reduced on-call pages by 45% with Prometheus and Grafana alerting",
            "Automated infrastructure with Terraform modules used by 8 product teams",
          ],
        },
        {
          id: "e2", title: "DevOps Engineer", company: "Nimbus Labs", startDate: "Mar 2019", endDate: "Dec 2021", location: "Lahore",
          bullets: [
            "Built Docker images and Jenkins jobs that shipped 200+ releases a year",
            "Improved Python tooling for 12 developers, cutting setup time from 2 days to 2 hours",
            "Launched cost dashboards in Grafana that trimmed cloud spend by 18%",
          ],
        },
      ],
    },
    { type: "education", id: "ed", title: "Education", items: [{ id: "d1", degree: "BS Computer Science", school: "FAST NUCES", startDate: "Sep 2014", endDate: "Jun 2018", location: "Lahore" }] },
    {
      type: "skills",
      id: "k",
      title: "Skills",
      categories: [
        { id: "c1", name: "Cloud", skills: ["AWS", "Kubernetes", "Terraform", "Docker", "Helm"] },
        { id: "c2", name: "Tooling", skills: ["Python", "Jenkins", "GitHub Actions", "Prometheus", "Grafana", "Linux", "Git"] },
      ],
    },
  ],
};

export const WEAK_RESUME = {
  leftColumnIds: ["s", "e", "x"],
  rightColumnIds: ["k"],
  sections: [
    { type: "header", id: "h", fullName: "Ali", title: "", contact: { email: "ali-at-mail" }, photoUrl: "data:image/png;base64,AAA" },
    { type: "summary", id: "s", title: "About me", content: "I am a hard-working team player." },
    {
      type: "experience",
      id: "e",
      title: "My Journey",
      items: [
        { id: "e1", title: "Developer", company: "", startDate: "01/2020", endDate: "Present", location: "", bullets: ["Responsible for managing the website", "Helped with testing", "Worked on bugs"] },
        { id: "e2", title: "Intern", company: "Startup", startDate: "", endDate: "", location: "", bullets: [] },
      ],
    },
    { type: "custom", id: "x", title: "Hobbies", items: [] },
    { type: "skills", id: "k", title: "Skills", categories: [{ id: "c", name: "", skills: ["HTML"] }] },
  ],
};

export const DEVOPS_JD = `Senior DevOps Engineer
We're looking for an engineer to own our cloud platform.
Requirements:
- 5+ years with AWS and K8s
- Terraform and CI/CD pipelines (GitHub Actions or Jenkins)
- Python or Go scripting
- Monitoring with Prometheus and Grafana
Nice to have:
- Ansible
- Experience with Datadog`;
