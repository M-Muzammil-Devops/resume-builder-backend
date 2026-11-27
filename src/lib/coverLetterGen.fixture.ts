/** Test fixture: a finalized resume for cover letter tests. */
export const RESUME_CONTENT = {
  leftColumnIds: [],
  rightColumnIds: [],
  sections: [
    {
      type: "header",
      id: "h",
      fullName: "Sara <b>Malik</b>",
      title: "Senior DevOps Engineer",
      contact: { email: "sara@example.com", phone: "+92 300 1234567", location: "Lahore, Pakistan", linkedin: "linkedin.com/in/sara" },
    },
    { type: "summary", id: "s", title: "Summary", content: "<p>DevOps engineer with 7 years building reliable cloud platforms.</p>" },
    {
      type: "experience",
      id: "e",
      title: "Experience",
      items: [
        {
          id: "e1",
          title: "Senior DevOps Engineer",
          company: "Acme Cloud",
          startDate: "Jan 2022",
          endDate: "Present",
          location: "Remote",
          bullets: ["Cut deployment time by 60% with GitHub Actions pipelines", "Mentored the platform team"],
        },
        { id: "e2", title: "DevOps Engineer", company: "Nimbus Labs", startDate: "2019", endDate: "2021", location: "", bullets: ["Migrated 40 services to Kubernetes"] },
      ],
    },
    { type: "skills", id: "k", title: "Skills", categories: [{ id: "c", name: "Cloud", skills: ["AWS", "Kubernetes", "Terraform", "Docker", "Python"] }] },
  ],
};
