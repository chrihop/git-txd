# Agent operating contract

- Own disjoint explicit files. A rename requires ownership of both paths.
- Finish writing and freeze requested files before submitting. Keep them frozen
  after a wait timeout/disconnect until durable status settles.
- Use a unique stable request ID for each logical commit. Reuse it with identical
  file operations/message/author on retry. Do not create a new ID to recover a
  lost response.
- Only the daemon may mutate Git state. Do not run `add`, `commit`, `push`,
  `fetch`, `pull`, `merge`, `rebase`, `reset`, `checkout`, `switch`, `stash`,
  `gc`, maintenance, or worktree mutations against the managed checkout.
- Unrelated unstaged work is normal. Do not stage somebody else's paths, invoke
  broad cleanup, remove lock files, change daemon state, or bypass a pause.
- Read commands are allowed. Use `git --no-optional-locks status`. Pin a commit
  SHA when multiple historical reads must describe one consistent snapshot.
- Queue inspection is informational. The actual acceptance sequence is assigned
  when the daemon durably accepts a request.
- `SUCCEEDED` means publication was confirmed; `NO_CHANGES` means no commit was
  needed. `IN_PROGRESS`, `PUSH_PENDING`, and `RECONCILIATION_REQUIRED` require
  status recovery and never imply rollback.
- On a repository pause, preserve working files and local commits and hand the
  durable transaction ID and error code to the operator.
