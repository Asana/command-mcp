import { z } from "zod";
import type { DiscoveryResult } from "../schema_discovery.js";
import { ReleaseReferenceSchema } from "../schema_discovery.js";

export const ReleaseMembershipSchema = ReleaseReferenceSchema.pick({
  gid: true,
  name: true,
});

export type ReleaseMembership = z.infer<typeof ReleaseMembershipSchema>;

export function currentReleaseMemberships(
  projects: ReadonlyArray<{ gid: string }> | undefined,
  snapshot: DiscoveryResult,
): ReleaseMembership[] {
  const projectGids = new Set((projects ?? []).map((project) => project.gid));
  return snapshot.releases
    .filter((release) => projectGids.has(release.gid))
    .map(({ gid, name }) => ({ gid, name }));
}
