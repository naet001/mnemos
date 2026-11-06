// One implementation of the SPEC §13 scope-visibility predicate, shared by
// memories list, both search legs, and proposals. Access rules must live in
// SQL and can never be overridden by relevance (§21.4); keeping three query
// paths on a single text prevents them from drifting apart.
export function scopeVisibilitySql(
  scopeCol: string,
  projectCol: string,
  ownerCol: string,
  actorParam: string,
  projectsParam: string,
): string {
  return `(
    ${scopeCol} = 'global'
    OR (${scopeCol} = 'private' AND ${ownerCol} = ${actorParam})
    OR (${scopeCol} = 'project' AND ${projectCol} = ANY(${projectsParam}::uuid[]))
  )`;
}
