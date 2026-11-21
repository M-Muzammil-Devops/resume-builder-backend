/** BUG-800: admin user search filters by email or name (case-insensitive). No term = all users. */
export function adminUserWhere(raw: string | undefined) {
  const term = (raw || "").trim().slice(0, 200);
  if (!term) return { role: "user" };
  return {
    role: "user",
    OR: [
      { email: { contains: term, mode: "insensitive" as const } },
      { name: { contains: term, mode: "insensitive" as const } },
    ],
  };
}
