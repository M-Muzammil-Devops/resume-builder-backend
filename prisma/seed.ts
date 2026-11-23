import "dotenv/config";
import bcrypt from "bcryptjs";
import { TEMPLATES, createSampleDevopsResume } from "../src/shared";
import { prisma } from "../src/prisma";

async function main() {
  console.log("Seeding templates...");
  for (const t of TEMPLATES) {
    await prisma.template.upsert({
      where: { id: t.id },
      create: t,
      update: t,
    });
  }

  console.log("Seeding jobs...");
  const jobs = [
    {
      title: "Senior DevOps Engineer",
      company: "CloudNova",
      location: "Remote",
      remote: true,
      department: "DevOps",
      description:
        "Build and operate Kubernetes platforms on AWS. Own CI/CD with GitHub Actions, Terraform, observability, and security hardening for microservices.",
      applyUrl: "https://example.com/jobs/devops-senior",
      keywords: ["Kubernetes", "AWS", "Terraform", "CI/CD", "Docker", "Prometheus"],
    },
    {
      title: "Site Reliability Engineer",
      company: "Uptime Labs",
      location: "Karachi, Pakistan",
      remote: false,
      department: "SRE",
      description:
        "Improve reliability SLOs, automate runbooks, and run EKS clusters with strong monitoring and incident response.",
      applyUrl: "https://example.com/jobs/sre",
      keywords: ["SRE", "EKS", "SLO", "Grafana", "On-call", "Python"],
    },
    {
      title: "Platform Engineer",
      company: "Forge Platforms",
      location: "Remote",
      remote: true,
      department: "Platform",
      description:
        "Design internal developer platforms, GitOps with Argo CD, and self-service infrastructure for engineering teams.",
      applyUrl: "https://example.com/jobs/platform",
      keywords: ["Platform", "Argo CD", "GitOps", "Helm", "Kubernetes"],
    },
    {
      title: "Cloud Engineer",
      company: "Skyline Digital",
      location: "Lahore, Pakistan",
      remote: true,
      department: "Cloud",
      description:
        "Provision AWS networking, IAM, CloudFront, and container workloads. Partner with app teams on cost and performance.",
      applyUrl: "https://example.com/jobs/cloud",
      keywords: ["AWS", "IAM", "CloudFront", "EC2", "Cost optimization"],
    },
    {
      title: "DevOps Engineer (Mid)",
      company: "Pipeline Co",
      location: "Remote",
      remote: true,
      department: "DevOps",
      description:
        "Maintain GitLab CI pipelines, Docker images, and multi-AZ deployments with Nginx and PostgreSQL.",
      applyUrl: "https://example.com/jobs/devops-mid",
      keywords: ["GitLab CI", "Docker", "Nginx", "PostgreSQL", "Multi-AZ"],
    },
  ];

  await prisma.job.deleteMany({});
  const createdJobs = [];
  for (const j of jobs) {
    createdJobs.push(await prisma.job.create({ data: j }));
  }

  // Demo user is OFF by default; enable only for local development with SEED_DEMO_USER=true + DEMO_PASSWORD.
  if (String(process.env.SEED_DEMO_USER || "false").toLowerCase() === "true") {
    const demoPassword = process.env.DEMO_PASSWORD || "";
    if (demoPassword.length < 8) throw new Error("SEED_DEMO_USER=true needs DEMO_PASSWORD (min 8 characters)");
    const email = "demo@resume.local";
    const passwordHash = await bcrypt.hash(demoPassword, 10);
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        passwordHash,
        name: "Demo User",
        autoApplyCredits: { create: { remaining: 50, processing: 0, applied: 0 } },
        autoApplyConfig: {
          create: {
            roles: ["DevOps Engineer", "SRE", "Platform Engineer"],
            locations: ["Remote", "Pakistan"],
            remote: true,
          },
        },
      },
      update: { passwordHash, name: "Demo User" },
    });

    const sample = createSampleDevopsResume();
    const existingResume = await prisma.resume.findFirst({ where: { userId: user.id } });
    if (!existingResume) {
      await prisma.resume.create({
        data: {
          userId: user.id,
          title: sample.title,
          templateId: sample.templateId,
          layoutKey: sample.layoutKey,
          content: sample.content as object,
          design: sample.design as object,
        },
      });
    }

    await prisma.jobApplication.deleteMany({ where: { userId: user.id } });
    const stages = ["recommended", "shortlist", "auto_apply", "applied", "interview"] as const;
    for (let i = 0; i < createdJobs.length; i++) {
      await prisma.jobApplication.create({
        data: {
          userId: user.id,
          jobId: createdJobs[i].id,
          stage: stages[i % stages.length],
        },
      });
    }
  } else {
    console.log("Demo user skipped (SEED_DEMO_USER is not true)");
  }

  console.log(`Seeded ${TEMPLATES.length} templates, ${createdJobs.length} jobs`);

  const adminEmail = process.env.ADMIN_EMAIL || "linux00011@gmail.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  if (!adminPassword) {
    throw new Error("ADMIN_PASSWORD is required (set it in .env). Refusing to seed an admin without one.");
  }
  if (adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
  }
  const adminHash = await bcrypt.hash(adminPassword, 10);
  await prisma.user.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      passwordHash: adminHash,
      name: process.env.ADMIN_NAME || "Admin",
      role: "admin",
      country: "Pakistan",
      location: "Remote",
      lastLoginAt: new Date(),
    },
    update: {
      passwordHash: adminHash,
      role: "admin",
      name: process.env.ADMIN_NAME || "Admin",
    },
  });
  console.log(`Admin login: ${adminEmail} / (ADMIN_PASSWORD)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
