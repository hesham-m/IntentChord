import { z } from "zod/v3";

export const projectContextStatuses = ["ACTIVE", "ARCHIVED"] as const;
export const projectContextWorkspaceRoles = ["PRIMARY", "SUPPORTING", "REFERENCE"] as const;

export type ProjectContextStatus = typeof projectContextStatuses[number];
export type ProjectContextWorkspaceRole = typeof projectContextWorkspaceRoles[number];

const boundedText = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum);
const isoDateTime = z.string().datetime({ offset: true });

export const createProjectContextCommandSchema = z.object({
  displayName: boundedText(1, 160),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,119}$/).optional(),
}).strict();

export const linkProjectContextWorkspaceCommandSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  workspaceRegistrationId: z.string().uuid(),
  role: z.enum(projectContextWorkspaceRoles),
  ordering: z.number().int().nonnegative().max(999),
  validFrom: isoDateTime.optional(),
  validUntil: isoDateTime.optional(),
}).strict().superRefine((value, context) => {
  if (value.validFrom && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.validFrom)) {
    context.addIssue({
      code: "custom",
      path: ["validUntil"],
      message: "validUntil must be later than validFrom.",
    });
  }
});

export type CreateProjectContextCommand = z.infer<typeof createProjectContextCommandSchema>;
export type LinkProjectContextWorkspaceCommand = z.infer<typeof linkProjectContextWorkspaceCommandSchema>;

export type ProjectContextWorkspaceView = {
  workspaceRegistrationId: string;
  displayName: string;
  workspaceRegistrationRole: string;
  role: ProjectContextWorkspaceRole;
  ordering: number;
  validFrom: string;
  validUntil?: string;
  revision: number;
  contentSha256: string;
  verificationStatus: string;
  sourceType: string;
};

export type ProjectContextView = {
  id: string;
  displayName: string;
  slug: string;
  status: ProjectContextStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workspaces: ProjectContextWorkspaceView[];
};

export function projectContextSlug(displayName: string, fallbackSuffix: string): string {
  const normalized = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  return normalized || `project-${fallbackSuffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
}
