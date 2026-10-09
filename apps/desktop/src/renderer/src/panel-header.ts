/**
 * The branch is shown only when it says something the worktree name does not: `feat/login` in a worktree called
 * `login` adds nothing, `main` in `acme-api` does.
 */
export function branchAddsInfo(branch: string | null, worktreeName: string): branch is string {
  if (!branch) return false
  if (branch === worktreeName) return false
  return branch.slice(branch.lastIndexOf('/') + 1) !== worktreeName
}
